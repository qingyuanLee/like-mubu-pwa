export function dailyPath(dateStr, journalFolder = 'journal') {
  const [y] = dateStr.split('-');
  return `${journalFolder}/${y}/${dateStr}.md`;
}

export function dailyTemplate(dateStr) {
  return `# ${dateStr} 日志

- 工作日志
- 生活记录
- 想法与备忘
`;
}
