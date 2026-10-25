// Shared by retained browser checks and negative fixtures. Inputs are computed sRGB colors.
export function contrast(foreground, background) {
  const luminance = color => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Unsupported computed color: ${color}`);
    const linear = channels.map(n => { const v = n / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
export function checkSample(sample) {
  if (sample.rootTheme !== sample.expectedTheme) throw new Error('Theme mismatch');
  if (sample.surface !== sample.tokenSurface) throw new Error('Broken surface token mapping');
  if (sample.badge && sample.badge.color !== sample.tokenStatus) throw new Error('Broken Flowbite token mapping');
  if (sample.brandOverflow > 1) throw new Error(`Clipped site title: ${sample.brandOverflow}`);
  if (sample.overflow > 1) throw new Error(`Page overflow: ${sample.overflow}`);
  for (const pair of sample.pairs) {
    if (contrast(pair.foreground, pair.background) < pair.minimum) throw new Error(`Insufficient contrast: ${pair.name}`);
  }
}
