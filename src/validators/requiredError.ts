/**
 * zod 4 replacement for zod 3's `{ required_error }` option: use `message`
 * only when the field is missing, and keep zod's default wording for other
 * type errors (e.g. a number where a string was expected).
 *
 *   z.string(requiredError('name is required'))
 */
export function requiredError(message: string): { error: (issue: { input?: unknown }) => string | undefined } {
  return { error: (issue) => (issue.input === undefined ? message : undefined) };
}
