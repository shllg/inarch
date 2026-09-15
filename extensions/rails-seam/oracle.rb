# Evaluate the real route DSL with ActionDispatch, without loading the application,
# initializers, dotenv, databases, credentials, or controller implementations.
# Controller constants are inert stubs because recognize_path checks their presence.
require "action_controller"
require "json"
require "digest"

repo, report_file, environment = ARGV
abort "usage: ruby oracle.rb REPO SCANNER_JSON [ENVIRONMENT]" unless repo && report_file
environment ||= "development"
route_source = File.read(File.join(repo, "config/routes.rb"))
report = JSON.parse(File.read(report_file))

module Rails
  class << self
    attr_accessor :application, :env
  end
end
module GoodJob
  Engine = ->(_env) { [404, {}, []] }
end
module ActionCable
  def self.server
    ->(_env) { [404, {}, []] }
  end
end
Rails.env = ActiveSupport::StringInquirer.new(environment)
route_set = ActionDispatch::Routing::RouteSet.new
Rails.application = Struct.new(:routes).new(route_set)
# Recognizing paths does not require application boot. Copy only explicit acronym
# declarations from source so e.g. LLMRoutingOverridesController has Rails' spelling.
inflections = File.join(repo, "config/initializers/inflections.rb")
if File.file?(inflections)
  File.read(inflections).scan(/^\s*\w+\.acronym\s+["']([A-Za-z0-9]+)["']/).flatten.each do |acronym|
    ActiveSupport::Inflector.inflections(:en) { |inflect| inflect.acronym(acronym) }
  end
end
Object.class_eval(route_source, File.join(repo, "config/routes.rb"), 1)
route_set.routes.each do |route|
  controller = route.defaults[:controller]
  next unless controller
  names = "#{controller.camelize}Controller".split("::")
  parent = Object
  names.each_with_index do |name, index|
    unless parent.const_defined?(name, false)
      parent.const_set(name, index == names.length - 1 ? Class.new(ActionController::Metal) : Module.new)
    end
    parent = parent.const_get(name, false)
  end
end

checks = []
# Distinct parameter witnesses cover ordinary numeric IDs, UUIDs, and slugs.
# They prove route recognition for these requests, not arbitrary runtime strings.
values = ["42", "550e8400-e29b-41d4-a716-446655440000", "sample-record"]
report.fetch("sites").each do |site|
  next unless site["matches"]
  site["matches"].each do |match|
    patterns = match.fetch("pattern").include?(":p") ? values : [nil]
    patterns.each do |value|
      request_path = match.fetch("pattern").gsub(":p", value.to_s)
      expected = { "controller" => match.fetch("controller"), "action" => match.fetch("action") }
      begin
        recognized = route_set.recognize_path(request_path, method: site.fetch("verb"))
        actual = { "controller" => recognized[:controller], "action" => recognized[:action] }
        checks << { file: site.fetch("file"), line: site.fetch("line"), method: site.fetch("verb"), path: request_path,
                    expected: expected, actual: actual, passed: actual == expected }
      rescue ActionController::RoutingError => error
        checks << { file: site.fetch("file"), line: site.fetch("line"), method: site.fetch("verb"), path: request_path,
                    expected: expected, passed: false, reason: error.message }
      end
    end
  end
end
puts JSON.pretty_generate({ framework: "ActionDispatch::Routing::RouteSet#recognize_path", actionpack: Gem.loaded_specs.fetch("actionpack").version.to_s,
  environment: environment, routes_sha256: Digest::SHA256.hexdigest(route_source), rails_route_count: route_set.routes.size,
  sites: report.fetch("stats").fetch("sites"), recognized_sites: report.fetch("sites").count { |site| site["matches"] },
  checks: checks.size, passed: checks.count { |check| check[:passed] }, failures: checks.reject { |check| check[:passed] }, results: checks })
