/**
 * The `npx` argv that runs the project's OWN Prisma CLI and never downloads one.
 *
 * Plain `npx prisma …` in a project without a local `prisma` installs whatever npm
 * calls `latest` — since October 2026 that is the Prisma 8 release candidate, whose
 * CLI has no `migrate deploy`, `migrate status` or `db push`. `--no` makes npx refuse
 * instead ("npx canceled due to missing packages"), and `--` keeps the Prisma flags
 * (`--version`, `--config`, …) away from npx's own option parser.
 */
export function localPrismaArgs(args: readonly string[]): string[] {
  return ['--no', '--', 'prisma', ...args]
}
