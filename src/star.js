// Asking people to star Troupe on GitHub. The interactive interfaces ask at most once at
// a good moment, after a first merge or the third time one of them opens, and never
// again once the person answers ("later" waits two weeks). Nothing is sent anywhere:
// the repository opens in the browser only when the person chooses it. `troupe run`
// never asks, and neither does any interface when the prompt is turned off.
import path from 'node:path';
import { readJson, writeJsonAtomic } from './util/fsx.js';

export const REPOSITORY_URL = 'https://github.com/AI-BizOS/troupe';
const LAUNCHES = 3;
const LATER_MS = 14 * 24 * 60 * 60 * 1000;
const ANSWERS = ['star', 'later', 'never'];

/**
 * @param {{file:string, now?:()=>number}} options `file` keeps the count and the answer
 * @returns {{url:string, opened():void, due(moment:'launch'|'merged'):boolean, answer(choice:'star'|'later'|'never'):void}}
 */
export function createStarPrompt({ file, now = Date.now }) {
  const read = () => {
    const state = readJson(file, null);
    return state && typeof state === 'object' ? state : {};
  };
  const write = (state) => writeJsonAtomic(file, { schema: 1, ...state });
  return {
    url: REPOSITORY_URL,
    opened() {
      const state = read();
      write({ ...state, launches: (Number(state.launches) || 0) + 1 });
    },
    due(moment) {
      const state = read();
      if (state.answer === 'star' || state.answer === 'never') return false;
      if (state.answer === 'later' && now() - Date.parse(state.at) < LATER_MS) return false;
      return moment === 'merged' || (Number(state.launches) || 0) >= LAUNCHES;
    },
    answer(choice) {
      if (!ANSWERS.includes(choice)) throw new Error(`Unknown answer: ${choice}`);
      write({ ...read(), answer: choice, at: new Date(now()).toISOString() });
    },
  };
}

/** The prompt for an interactive interface, or null when the user turned it off. */
export function starPromptFor({ home, config, env = process.env }) {
  if (config?.starPrompt === false || env.TROUPE_NO_STAR_PROMPT || env.CI) return null;
  return createStarPrompt({ file: path.join(home, 'star.json') });
}
