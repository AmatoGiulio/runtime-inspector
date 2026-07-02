export function makeMutable<T>(value: T): { value: T } {
  return { value };
}
