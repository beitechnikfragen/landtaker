/**
 * Shims for game imports that only Vite can resolve. The backend never
 * executes this code — it is pulled in transitively by the shared Zod schemas
 * and only needs to type-check.
 */
declare module "*?worker&inline" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
