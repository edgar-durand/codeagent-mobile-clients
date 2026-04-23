// The virtual terminal, selector detection, and chrome filter all live in
// @codeagent/shared so this extension processes terminal output byte-for-byte
// identically to codeam-cli. Keeping the same module name as a re-export so
// existing callers don't have to change their import paths.
export {
  detectListSelector,
  detectSelector,
  filterChrome,
  renderToLines,
  type SelectPrompt,
} from '@codeagent/shared';
