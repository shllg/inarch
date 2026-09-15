import { test } from 'node:test';
import assert from 'node:assert/strict';
import runtime from './runtime.mjs';

const registryPath = 'app/services/action_registry.rb';
const chainPath = 'app/services/messaging/classifier_chain.rb';
const cronPath = 'config/initializers/good_job.rb';
const dispatcherPath = 'app/services/runtime/dispatcher.rb';
const registry = `class ActionRegistry
 Entry = Data.define(:name, :action_class, :enabled, :side_effects) do
  def initialize(name:, action_class:, enabled: false, side_effects: nil)
   super(name: name.to_s, action_class: action_class.to_s, enabled: enabled == true, side_effects: side_effects&.to_sym)
  end
 end
 REGISTRY = [
  Entry.new(name: "action.drop", action_class: "Actions::Drop", enabled: true, side_effects: :write),
  Entry.new(name: "other", action_class: "OtherAction")
 ].to_h { |entry| [ entry.name, entry ] }.freeze
 class << self
  def registered_action_class(action_name)
   registered_entry_for_name(action_name)&.action_class&.safe_constantize
  end
  def registered_entries
   REGISTRY.values.select(&:enabled).sort_by(&:name)
  end
  def registered_entry_for_name(action_name)
   normalized = action_name.to_s.delete_prefix("action.")
   registered_entries.find { |entry| entry.name.delete_prefix("action.") == normalized }
  end
 end
end`;
const dispatcher = `class Runtime::Dispatcher
 def call(request:, context:, item:)
  action_class = ActionRegistry.registered_action_class(request.name)
  return unless action_class
  action_class.new(context:, item:).call(arguments: {})
 end
end`;
const chain = `module Messaging
 class ClassifierChain
  CLASSIFIERS = ["FirstClassifier", "SecondClassifier"].freeze
  class << self
   def call(message:, conversation:)
    classifiers.each do |classifier|
     next unless classifier.applicable?(message:, conversation:)
     result = classifier.call(message:, conversation:)
     return :handled if result == :handled
    end
    :passthrough
   end
   def classifiers
    CLASSIFIERS.map(&:constantize)
   end
  end
 end
end`;
const cron = `Rails.application.configure do
 cron_entries = {
  sweep: { cron: "*/5 * * * *", class: "SweepJob", description: "sweep" }
 }
 if ENV["ENABLE_OPTIONAL"].present?
  cron_entries[:optional] = { cron: "* * * * *", class: "OptionalJob" }
 end
 config.good_job.cron = cron_entries
end`;
// The shapes the analyzer must verify before it will emit an edge. They are
// configuration, not literals in the extension, so the same code serves an
// application that spells its registry, chain or schedule differently.
export const config = {
  railsRuntime: {
    registry: {
      file: registryPath,
      class: 'ActionRegistry',
      entry: {
        const: 'Entry',
        shape: `Data.define(:name, :action_class, :enabled, :side_effects) do
 def initialize(name:, action_class:, enabled: false, side_effects: nil)
 super(name: name.to_s, action_class: action_class.to_s, enabled: enabled == true, side_effects: side_effects&.to_sym)
 end
 end`,
      },
      table: {
        const: 'REGISTRY',
        block: '{ |entry| [ entry.name, entry ] }',
        fields: ['name', 'action_class', 'enabled', 'side_effects'],
        key: 'name', target: 'action_class', select: 'enabled', keyPrefix: 'action.',
      },
      methods: {
        resolver: { name: 'registered_action_class', body: 'registered_entry_for_name(action_name)&.action_class&.safe_constantize' },
        list: { name: 'registered_entries', body: 'REGISTRY.values.select(&:enabled).sort_by(&:name)' },
        lookup: { name: 'registered_entry_for_name', body: `normalized = action_name.to_s.delete_prefix("action.")
registered_entries.find { |entry| entry.name.delete_prefix("action.") == normalized }` },
      },
      dispatcher: {
        file: dispatcherPath, class: 'Runtime::Dispatcher', method: 'call',
        local: 'action_class', assignment: 'ActionRegistry.registered_action_class(request.name)', invokes: 'call',
      },
    },
    chain: {
      file: chainPath,
      class: 'Messaging::ClassifierChain',
      const: 'CLASSIFIERS',
      methods: {
        list: { name: 'classifiers', body: 'CLASSIFIERS.map(&:constantize)' },
        caller: { name: 'call', body: `classifiers.each do |classifier|
 next unless classifier.applicable?(message:, conversation:)
 result = classifier.call(message:, conversation:)
 return :handled if result == :handled
 end
 :passthrough` },
      },
      probes: ['applicable?', 'call'],
    },
    scheduler: {
      file: cronPath,
      namespace: 'good_job', setting: 'cron', local: 'cron_entries',
      settings: ['preserve_job_records', 'cleanup_preserved_jobs_before_seconds_ago', 'retry_on_unhandled_error', 'on_thread_error'],
      entry: { schedule: 'cron', class: 'class' },
      symbol: 'GoodJob.cron', label: 'GoodJob cron',
    },
  },
};

export function context(extra = {}) {
  const files = {
    [registryPath]: registry, [dispatcherPath]: dispatcher, [chainPath]: chain, [cronPath]: cron,
    'app/services/actions/drop.rb': 'class Actions::Drop < Actions::Base\n def perform; end\nend',
    'app/services/actions/base.rb': 'class Actions::Base\n def call(arguments:); perform; end\nend',
    'app/services/other_action.rb': 'class OtherAction\n def call; end\nend',
    'app/services/first_classifier.rb': 'class FirstClassifier\n def self.call(message:, conversation:); end\n def self.applicable?(message:, conversation:); end\n def call; end\nend',
    'app/services/second_classifier.rb': 'class SecondClassifier\n def self.call(message:, conversation:); end\n def self.applicable?(message:, conversation:); end\nend',
    'app/jobs/application_job.rb': 'class ApplicationJob < ActiveJob::Base\nend',
    'app/jobs/sweep_job.rb': 'class SweepJob < ApplicationJob\n def perform; end\nend',
    'app/jobs/optional_job.rb': 'class OptionalJob < ApplicationJob\n def perform; end\nend',
    ...extra,
  };
  // Test symbols intentionally include class/instance name collisions; source
  // declaration lines, rather than the first same-name index result, identify it.
  const byPath = {};
  for (const [file, text] of Object.entries(files)) {
    if (text === null) continue;
    const symbols = [{ id: file + '#file', name: file, kind: 'file', startLine: 1, endLine: text.split('\n').length }];
    const owner = ({ [registryPath]: 'ActionRegistry', [dispatcherPath]: 'Runtime.Dispatcher', [chainPath]: 'Messaging.ClassifierChain' })[file]
      ?? text.match(/class ([\w:]+)/)?.[1].replaceAll('::', '.');
    if (owner) symbols.push({ id: file + '#' + owner, name: owner.split('.').at(-1), kind: 'class', startLine: text.split('\n').findIndex(l => l.includes('class ' + owner.split('.').at(-1)) || l.includes('class ' + owner.replaceAll('.', '::'))) + 1, endLine: text.split('\n').length });
    for (const [i, line] of text.split('\n').entries()) {
      const match = line.match(/\bdef (?:self\.)?([\w?!]+)/);
      if (match) symbols.push({ id: file + '#' + owner + '.' + match[1] + '@L' + (i + 1), name: match[1], kind: 'method', startLine: i + 1, endLine: i + 1 });
    }
    byPath[file] = symbols;
  }
  return { config, readFile: p => files[p] ?? null, listFiles: () => Object.keys(files).filter(p => files[p] !== null), index: { byPath }, log: () => { } };
}
const edgesFor = (result, token) => result.edges.filter(e => e.via?.includes(token));

test('runtime: action registry emits conditional targets with literal key evidence and inherited call', async () => {
  const result = await runtime(context());
  const edges = edgesFor(result, 'action.drop');
  assert.ok(edges.some(e => e.source.includes('Dispatcher.call') && e.target.includes('Base.call') && e.relation === 'dispatches'));
  assert.ok(edges.some(e => e.source.includes('registered_action_class') && e.target.endsWith('#Actions.Drop')));
  assert.ok(!edges.some(e => e.target.includes('OtherAction')));
  assert.ok(edges.every(e => e.via.includes('possible')));
});

test('runtime: classifier choices resolve singleton methods and preserve conditional dispatch', async () => {
  const result = await runtime(context());
  const edges = edgesFor(result, 'CLASSIFIERS');
  assert.equal(edges.filter(e => e.target.includes('Classifier.call')).length, 2);
  assert.ok(edges.every(e => e.relation === 'dispatches'));
  assert.ok(edges.some(e => e.target.endsWith('FirstClassifier.call@L2')));
  assert.ok(!edges.some(e => e.target.endsWith('@L4')));
});

test('runtime: GoodJob literal schedules become source-backed nodes and async perform targets', async () => {
  const result = await runtime(context());
  const edges = edgesFor(result, 'GoodJob');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].relation, 'enqueues');
  assert.ok(edges[0].target.includes('SweepJob.perform'));
  assert.ok(edges[0].via.includes('*/5 * * * *'));
  const node = result.nodes.find(n => n.id === edges[0].source);
  assert.equal(node.path, cronPath);
  assert.equal(node.span, 'L3-L3');
});

for (const [name, change] of Object.entries({
  'commented registry': { [registryPath]: registry.split('\n').map(l => '# ' + l).join('\n') },
  'registry in string': { [registryPath]: 'payload = <<~RUBY\n' + registry + '\nRUBY' },
  'conditional registry': { [registryPath]: registry.replace(' REGISTRY =', ' if enabled?\n REGISTRY =').replace(' class << self', ' end\n class << self') },
  'interpolated class': { [registryPath]: registry.replace('Actions::Drop', 'Actions::#{chosen}') },
  'duplicate registry key': { [registryPath]: registry.replace('name: "other"', 'name: "action.drop"') },
  'registry reassignment': { [registryPath]: registry.replace(' class << self', ' REGISTRY = []\n class << self') },
  'changed resolver': { [registryPath]: registry.replace('registered_entry_for_name(action_name)&.action_class&.safe_constantize', 'Other.lookup(action_name)') },
  'rebound dispatcher variable': { [dispatcherPath]: dispatcher.replace('  return unless', '  action_class = OtherAction\n  return unless') },
  'missing target': { 'app/services/actions/drop.rb': null },
  'class reopening': { 'app/services/actions/drop_patch.rb': 'class Actions::Drop\n def call; end\nend' },
})) test('runtime decline: ' + name, async () => {
  const result = await runtime(context(change));
  const edges = edgesFor(result, 'action.drop');
  if (name === 'rebound dispatcher variable') assert.ok(!edges.some(e => e.source.includes('Dispatcher')));
  else assert.equal(edges.length, 0);
});

for (const [name, source] of Object.entries({
  conditional: chain.replace('  CLASSIFIERS =', '  if feature?\n  CLASSIFIERS =').replace('  class << self', '  end\n  class << self'),
  mutated: chain.replace('  class << self', '  CLASSIFIERS << "Other"\n  class << self'),
  interpolated: chain.replace('"FirstClassifier"', '"#{chosen}"'),
  changed: chain.replace('CLASSIFIERS.map(&:constantize)', 'OTHER.map(&:constantize)'),
})) test('runtime decline classifier: ' + name, async () => assert.equal(edgesFor(await runtime(context({ [chainPath]: source })), 'CLASSIFIERS').length, 0));

for (const [name, source] of Object.entries({
  unattached: cron.replace(' config.good_job.cron = cron_entries', ''),
  overwritten: cron.replace(' config.good_job.cron = cron_entries', ' cron_entries = {}\n config.good_job.cron = cron_entries'),
  replacement: cron.replace('cron_entries[:optional]', 'cron_entries[:sweep]'),
  unknownMutation: cron.replace(' config.good_job.cron = cron_entries', ' alter(cron_entries)\n config.good_job.cron = cron_entries'),
  interpolated: cron.replace('"SweepJob"', '"#{chosen}"'),
})) test('runtime decline schedule: ' + name, async () => assert.equal(edgesFor(await runtime(context({ [cronPath]: source })), 'GoodJob').length, 0));

for (const [name, change] of Object.entries({
  'altered Entry constructor': { [registryPath]: registry.replace('action_class: action_class.to_s', 'action_class: "OtherAction"') },
  'conditional method redefinition': { [registryPath]: registry.replace('  def registered_entries', '  if enabled?\n   def registered_action_class(action_name); OtherAction; end\n  end\n  def registered_entries') },
  'registry element replacement': { [registryPath]: registry.replace(' class << self', ' REGISTRY["action.drop"] = other\n class << self') },
  'registry escaped to helper': { [registryPath]: registry.replace(' class << self', ' rewrite(REGISTRY)\n class << self') },
  'registry alias': { [registryPath]: registry.replace(' class << self', ' alias_registry = REGISTRY\n class << self') },
})) test('runtime strict registry: ' + name, async () => assert.equal(edgesFor(await runtime(context(change)), 'REGISTRY').length, 0));

for (const [name, change] of Object.entries({
  'classifier alias': chain.replace('  class << self', '  list = CLASSIFIERS\n  list[0] = "Other"\n  class << self'),
  'classifier replacement': chain.replace('  class << self', '  CLASSIFIERS[0] = "Other"\n  class << self'),
})) test('runtime strict classifier: ' + name, async () => assert.equal(edgesFor(await runtime(context({ [chainPath]: change })), 'CLASSIFIERS').length, 0));

for (const [name, source] of Object.entries({
  'cron in comment': cron.split('\n').map(l => '# ' + l).join('\n'),
  'cron in heredoc': 'text = <<~RUBY\n' + cron + '\nRUBY',
  'cron conditional replacement': cron.replace(' config.good_job.cron = cron_entries', ' if enabled?\n config.good_job.cron = {}\n end\n config.good_job.cron = cron_entries'),
  'cron method redefinition': cron.replace(' config.good_job.cron = cron_entries', ' cron_entries.clear\n config.good_job.cron = cron_entries'),
})) test('runtime strict scheduler: ' + name, async () => assert.equal(edgesFor(await runtime(context({ [cronPath]: source })), 'GoodJob').length, 0));

test('runtime: equivalent normalized action keys decline conflicting possible targets', async () => {
  const source = registry.replace('name: "other", action_class: "OtherAction"', 'name: "drop", action_class: "OtherAction", enabled: true');
  assert.equal(edgesFor(await runtime(context({ [registryPath]: source })), 'REGISTRY').length, 0);
});

test('runtime: class constructors returning other objects cannot imply instance call targets', async () => {
  const result = await runtime(context({ 'app/services/actions/drop.rb': 'class Actions::Drop < Actions::Base\n def self.new; OtherAction.new; end\nend' }));
  assert.ok(!result.edges.some(e => e.source.includes('Dispatcher.call')));
});

test('runtime: redefining Entry.new invalidates its literal registry interpretation', async () => {
  const source = registry.replace(' class << self', ' def Entry.new(**args); other; end\n class << self');
  assert.equal(edgesFor(await runtime(context({ [registryPath]: source })), 'REGISTRY').length, 0);
});


test('runtime: shared inherited targets aggregate all verified registry possibilities before host deduplication', async () => {
  const result = await runtime(context({
    [registryPath]: registry.replace('name: "other", action_class: "OtherAction"', 'name: "action.notify", action_class: "Actions::Notify", enabled: true'),
    'app/services/actions/notify.rb': 'class Actions::Notify < Actions::Base\nend',
  }));
  const dispatch = result.edges.filter(e => e.source.includes('Dispatcher.call'));
  assert.equal(dispatch.length, 1);
  assert.ok(dispatch[0].via.includes('action.drop -> Actions::Drop'));
  assert.ok(dispatch[0].via.includes('action.notify -> Actions::Notify'));
  assert.ok(Buffer.byteLength(dispatch[0].via) <= 1024);
});

for (const [name, source] of Object.entries({
  conditional: 'class Actions::Drop < Actions::Base\n if true\n def self.new; OtherAction.new; end\n end\nend',
  singletonPrepend: 'class Actions::Drop < Actions::Base\n class << self\n prepend FactoryOverride\n end\nend',
  unknownParent: 'class Actions::Drop < UnknownFactory\n def call; end\nend',
})) test('review: constructor absence must be proved: ' + name, async () => {
  const result = await runtime(context({ 'app/services/actions/drop.rb': source }));
  assert.ok(!result.edges.some(e => e.source.includes('Dispatcher.call')));
  assert.ok(result.edges.some(e => e.source.includes('registered_action_class') && e.target.endsWith('#Actions.Drop')));
});

for (const binder of ['|action_class|', '|ignored; action_class|']) test('review: block-local dispatcher receiver declines ' + binder, async () => {
  const source = dispatcher.replace('action_class.new(context:, item:).call(arguments: {})', `[OtherAction].each do ${binder}\n action_class.new.call\n end`);
  assert.ok(!(await runtime(context({ [dispatcherPath]: source }))).edges.some(e => e.source.includes('Dispatcher.call')));
});

for (const declaration of ['private :call', 'protected :call', 'private(*names)', 'if enabled?\n private :call\n end']) test('review: inherited receiver visibility ' + declaration, async () => {
  const source = `class Actions::Drop < Actions::Base\n ${declaration}\nend`;
  assert.ok(!(await runtime(context({ 'app/services/actions/drop.rb': source }))).edges.some(e => e.source.includes('Dispatcher.call')));
});

for (const mutation of [
  'Rails.application.config.good_job.cron.clear',
  'Rails.application.config.good_job.cron[:sweep][:class] = "OptionalJob"',
  'rewrite(Rails.application.config.good_job.cron)',
  'alias_config = Rails.application.config.good_job\nalias_config.cron = {}',
  'Rails.application.config.good_job.cron ||= {}',
]) test('review: attached cron configuration mutation or escape declines ' + mutation, async () => {
  assert.equal(edgesFor(await runtime(context({ [cronPath]: cron + '\n' + mutation })), 'GoodJob').length, 0);
});

test('review: configuration alias inside configure also invalidates cron', async () => {
  const source = cron.replace(' config.good_job.cron = cron_entries', ' config.good_job.cron = cron_entries\n target = config.good_job\n target.cron.clear');
  assert.equal(edgesFor(await runtime(context({ [cronPath]: source })), 'GoodJob').length, 0);
});

test('review: reopening Entry singleton and prepending resolver decline registry assertions', async () => {
  for (const source of [registry.replace(' class << self', ' class << Entry\n def new(**args); other; end\n end\n class << self'), registry.replace(' class << self', ' class << self\n prepend ResolverOverride')]) {
    assert.equal(edgesFor(await runtime(context({ [registryPath]: source })), 'REGISTRY').length, 0);
  }
});

for (const mutation of [
  'settings = Rails.application.config\nsettings.good_job.cron.clear',
  'application = Rails.application\napplication.config.good_job.cron.clear',
]) test('review: escaping a cron configuration ancestor declines ' + mutation, async () => {
  assert.equal(edgesFor(await runtime(context({ [cronPath]: cron + '\n' + mutation })), 'GoodJob').length, 0);
});

test('review: a receiver can explicitly restore public visibility for an inherited call', async () => {
  const result = await runtime(context({
    'app/services/actions/base.rb': 'class Actions::Base\n private\n def call(arguments:); end\nend',
    'app/services/actions/drop.rb': 'class Actions::Drop < Actions::Base\n public :call\nend',
  }));
  assert.ok(result.edges.some(e => e.source.includes('Dispatcher.call')));
});

for (const [name, mutation] of Object.entries({
  destructuring: 'action_class, ignored = OtherAction, nil',
  nestedDestructuring: '(ignored, (action_class, other)) = values',
  splatDestructuring: 'ignored, *action_class = values',
  forTarget: 'for action_class in [OtherAction]\n end',
  nestedForTarget: 'for ignored, (action_class, other) in values\n end',
  rescueTarget: 'begin\n work\n rescue => action_class\n end',
  rightwardPattern: 'value => action_class',
  arrayPattern: 'case value\n in [action_class, *rest]\n end',
  hashPattern: 'case value\n in {action_class:}\n end',
  predicatePattern: 'value in {action_class:}',
  lambdaParameter: '->(action_class) { nil }',
  blockParameter: 'values.each { |action_class| nil }',
  blockLocal: 'values.each { |other; action_class| nil }',
  regexCapture: '/(?<action_class>.*)/ =~ value',
  bindingMutation: 'binding.local_variable_set(:action_class, OtherAction)',
  dynamicEval: 'eval("action_class = OtherAction")',
  reflectiveEval: 'send(:eval, "action_class = OtherAction")',
})) test('binding proof declines every unsupported local binder: ' + name, async () => {
  const source = dispatcher.replace('  return unless action_class', mutation + '\n  return unless action_class');
  const result = await runtime(context({ [dispatcherPath]: source }));
  assert.ok(!result.edges.some(e => e.source.includes('Dispatcher.call')), name);
  assert.ok(result.edges.some(e => e.source.includes('registered_action_class')), 'registry mapping remains independently valid');
});

test('binding proof retains supported straight-line reads and keyword shorthand', async () => {
  const source = dispatcher.replace('  return unless action_class', '  arguments = allowlisted_arguments(action_class:, original: action_class)\n  return unless action_class');
  assert.ok((await runtime(context({ [dispatcherPath]: source }))).edges.some(e => e.source.includes('Dispatcher.call')));
});
