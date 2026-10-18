// Tiny argument helpers shared by the CLI entries. Deliberately minimal:
// the CLIs take a handful of --name value pairs and nothing else.

export function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
