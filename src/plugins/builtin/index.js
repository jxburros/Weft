import markdown from './markdown.js';
import citations from './citations.js';
import sessionStats from './session-stats.js';

/** Built-in plugins, reviewed with core and registered in this order. Core never imports these modules. */
export const BUILTIN = Object.freeze([markdown, citations, sessionStats]);
