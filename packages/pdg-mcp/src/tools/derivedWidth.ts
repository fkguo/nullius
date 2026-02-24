import { invalidParams } from '@autoresearch/shared';

const HBAR_EV_S = 6.582119569e-16;

function secondsFactor(unitText: string): number | null {
  const u = unitText.trim();
  if (u === 's' || u === 'sec' || u === 'second' || u === 'seconds') return 1;
  if (u === 'ms') return 1e-3;
  if (u === 'us' || u === 'µs' || u === 'μs') return 1e-6;
  if (u === 'ns') return 1e-9;
  if (u === 'ps') return 1e-12;
  if (u === 'fs') return 1e-15;
  if (u === 'as') return 1e-18;
  return null;
}

function trimZeros(s: string): string {
  if (s.includes('e') || s.includes('E')) return s;
  if (!s.includes('.')) return s;
  return s.replaceAll(/\.?0+$/g, m => (m.startsWith('.') ? '' : ''));
}

function chooseExponentForDisplay(value: number): number {
  const abs = Math.abs(value);
  if (!Number.isFinite(abs) || abs === 0) return 0;
  if (abs >= 1e4 || abs < 1e-3) return Math.floor(Math.log10(abs));
  return 0;
}

function formatScaledValueWithError(value: number, error: number | null): { display_value_text: string; exponent: number } {
  const exponent = chooseExponentForDisplay(value);
  const scale = 10 ** exponent;
  const scaledValue = value / scale;
  const scaledError = error === null ? null : error / scale;

  if (scaledError === null || !Number.isFinite(scaledError) || scaledError <= 0) {
    return { display_value_text: trimZeros(scaledValue.toPrecision(4)), exponent };
  }

  const errStrRaw = trimZeros(scaledError.toPrecision(2));
  if (errStrRaw.includes('e') || errStrRaw.includes('E')) {
    return { display_value_text: `${trimZeros(scaledValue.toPrecision(4))}+-${errStrRaw}`, exponent: 0 };
  }

  const decimals = (() => {
    const idx = errStrRaw.indexOf('.');
    if (idx < 0) return 0;
    return Math.min(8, errStrRaw.length - idx - 1);
  })();

  const valueStr = trimZeros(scaledValue.toFixed(decimals));
  return { display_value_text: `${valueStr}+-${errStrRaw}`, exponent };
}

export function deriveWidthFromLifetime(options: {
  lifetime_value: number;
  lifetime_error_positive: number | null;
  lifetime_error_negative: number | null;
  lifetime_unit_text: string | null;
}): {
  constants: { hbar_ev_s: number };
  value: {
    display_value_text: string;
    unit_text: 'eV';
    value: number;
    error_positive: number | null;
    error_negative: number | null;
    display_power_of_ten: number;
    display_in_percent: false;
  };
} {
  const unit = options.lifetime_unit_text?.trim();
  if (!unit) {
    throw invalidParams('Cannot derive width: lifetime unit_text is missing', {
      lifetime_unit_text: options.lifetime_unit_text,
    });
  }

  const factor = secondsFactor(unit);
  if (!factor) {
    throw invalidParams('Cannot derive width: unsupported lifetime unit', {
      lifetime_unit_text: unit,
      supported: ['s', 'ms', 'us', 'µs', 'μs', 'ns', 'ps', 'fs', 'as'],
    });
  }

  const tau = options.lifetime_value * factor;
  if (!Number.isFinite(tau) || tau <= 0) {
    throw invalidParams('Cannot derive width: lifetime value must be positive', {
      lifetime_value: options.lifetime_value,
      lifetime_unit_text: unit,
    });
  }

  const width = HBAR_EV_S / tau;

  const errPos = (() => {
    const e = options.lifetime_error_positive;
    if (e === null || e === undefined) return null;
    const absErr = Math.abs(e) * factor;
    if (!Number.isFinite(absErr) || absErr <= 0) return null;
    return width * (absErr / tau);
  })();

  const errNeg = (() => {
    const e = options.lifetime_error_negative;
    if (e === null || e === undefined) return null;
    const absErr = Math.abs(e) * factor;
    if (!Number.isFinite(absErr) || absErr <= 0) return null;
    return width * (absErr / tau);
  })();

  const symmetric = (() => {
    if (errPos !== null) return errPos;
    if (errNeg !== null) return errNeg;
    return null;
  })();

  const { display_value_text, exponent } = formatScaledValueWithError(width, symmetric);

  return {
    constants: { hbar_ev_s: HBAR_EV_S },
    value: {
      display_value_text,
      unit_text: 'eV',
      value: width,
      error_positive: errPos,
      error_negative: errNeg,
      display_power_of_ten: exponent,
      display_in_percent: false,
    },
  };
}

