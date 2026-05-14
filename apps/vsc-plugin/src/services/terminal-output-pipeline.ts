// The virtual terminal stays in @codeagent/shared because byte→lines
// rendering is agent-agnostic. Selector detection and chrome filtering
// are Claude-specific and live in ./parseChrome (the local Claude
// strategy module). Keeping the same re-export surface so existing
// callers don't have to change their import paths.
export { renderToLines } from '@codeagent/shared';
export {
  detectListSelector,
  detectSelector,
  filterChrome,
  type SelectPrompt,
} from './parseChrome';
