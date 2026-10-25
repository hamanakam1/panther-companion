export function companionBounds(displays: { id: number; workArea: { x: number; y: number; width: number; height: number } }[], primaryId: number) {
  const other = displays.filter(display => display.id !== primaryId).sort((a, b) => b.workArea.width * b.workArea.height - a.workArea.width * a.workArea.height);
  const display = other[0] ?? displays.find(display => display.id === primaryId) ?? displays[0];
  const area = display?.workArea ?? { x: 0, y: 0, width: 1280, height: 800 };
  const width = Math.min(700, Math.max(420, Math.floor(area.width * 0.3)), area.width);
  return { x: area.x + area.width - width, y: area.y, width, height: area.height };
}
