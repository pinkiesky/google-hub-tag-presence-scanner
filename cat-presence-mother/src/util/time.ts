export const wallTime = (): number => Date.now() / 1000;
export const monotonicTime = (): number => performance.now() / 1000;
