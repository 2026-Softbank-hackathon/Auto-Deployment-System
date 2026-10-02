const WIDTH = 120;
const HEIGHT = 32;

/**
 * 0~100(%) 값의 작은 추이 선. 값이 없는 칸(null)에서는 선을 끊는다.
 * threshold 를 주면 경고 기준선을 점선으로 그린다.
 */
export function Sparkline({ values, label, threshold }: { values: Array<number | null>; label: string; threshold?: number }) {
  const step = values.length > 1 ? WIDTH / (values.length - 1) : 0;
  const y = (value: number) => HEIGHT - (Math.min(100, Math.max(0, value)) / 100) * HEIGHT;
  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${(index * step).toFixed(1)},${y(value).toFixed(1)}`);
  });
  if (current.length) segments.push(current.join(' '));

  return <svg className="ops-spark" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
    {threshold !== undefined && <line className="ops-spark__threshold" x1="0" x2={WIDTH} y1={y(threshold)} y2={y(threshold)} />}
    {segments.map((points, index) => points.includes(' ')
      ? <polyline key={index} className="ops-spark__line" points={points} />
      : <circle key={index} className="ops-spark__dot" cx={points.split(',')[0]} cy={points.split(',')[1]} r="1.5" />)}
  </svg>;
}
