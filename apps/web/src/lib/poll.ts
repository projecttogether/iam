/** How often pages ask again: often while something waits or runs, otherwise every minute. */
export function pollEvery(active: boolean): number {
  return active ? 10_000 : 60_000;
}
