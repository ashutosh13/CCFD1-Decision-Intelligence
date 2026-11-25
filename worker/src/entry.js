// Worker entry. workerd rejects non-handler named exports (MAX_BODY_BYTES etc.) on the main module,
// so expose only the handler here; index.js keeps its named exports for the tests.
export { default } from "./index.js";
