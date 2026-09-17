/**
 * Make one native module unloadable, in-process, for a child `node` run.
 *
 * Used with `--require` so the break is installed BEFORE inarch's own modules are
 * evaluated — which is the whole point of the test it serves. The reported symptom
 * was that `inarch --version` died before argv was read, so a harness that breaks the
 * module after startup would not reproduce it.
 *
 * `GRAFT_BREAK_MODULE` names the module (comma-separated for several). The error text
 * imitates node-gyp-build's real one, because the diagnostic layer quotes it verbatim
 * and a test that asserts on a friendly message would not catch a regression to an
 * unreadable one.
 */
const Module = require("node:module");
const broken = new Set((process.env.GRAFT_BREAK_MODULE || "").split(",").filter(Boolean));
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (broken.has(request)) {
    throw new Error(
      `No native build was found for platform=${process.platform} arch=${process.arch} ` +
        `runtime=node abi=147 uv=1 libc=glibc node=${process.versions.node}`,
    );
  }
  return load.call(this, request, parent, isMain);
};
