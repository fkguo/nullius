export function formatPdgDisplayText(options: {
  display_value_text: string | null;
  unit_text: string | null;
  display_power_of_ten: number | null;
  display_in_percent: boolean;
}): string | null {
  const { display_value_text, unit_text, display_power_of_ten, display_in_percent } = options;
  if (!display_value_text || display_value_text.trim().length === 0) return null;

  let text = display_value_text;

  const hasExponent = /[Ee][+-]?\d+/.test(text);

  if (!display_in_percent && !hasExponent && display_power_of_ten && display_power_of_ten !== 0) {
    text = `(${text})E${display_power_of_ten}`;
  }

  if (display_in_percent && !text.includes('%')) {
    text = `${text} %`;
  }

  if (unit_text && unit_text.trim().length > 0) {
    text = `${text} ${unit_text}`;
  }

  return text;
}

