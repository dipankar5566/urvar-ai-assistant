export function createTracker() {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

export function addUsage(tracker, usage) {
  if (!tracker || !usage) return;
  tracker.input_tokens += usage.input_tokens || 0;
  tracker.output_tokens += usage.output_tokens || 0;
  tracker.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
  tracker.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
}

export function formatSummary(tracker) {
  const { input_tokens: i, output_tokens: o, cache_read_input_tokens: cr } = tracker;
  let line = `\n\n_🔢 ${i.toLocaleString()} in | ${o.toLocaleString()} out`;
  if (cr > 0) line += ` | ${cr.toLocaleString()} cached`;
  line += `_`;
  return line;
}
