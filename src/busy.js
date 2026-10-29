// A tiny shared counter so background work (solo thoughts) can tell whether a reply is being
// generated right now. Kept separate from companion.js so pressure.js and thoughts.js can use it
// without importing the reply pipeline (and creating a cycle).
let replies = 0;

export const beginReply = () => ++replies;
export const endReply = () => {
  replies = Math.max(0, replies - 1);
};
export const replyInFlight = () => replies > 0;
