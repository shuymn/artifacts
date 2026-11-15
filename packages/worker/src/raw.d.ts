// Vite's `?raw` imports, used by tests to read source files as text.
declare module "*?raw" {
  const text: string;
  export default text;
}
