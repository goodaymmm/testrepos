export function createT199ApprovalId(soakId, date, index) {
  if (!/^SSK-\d{14}-[a-f0-9]{12}$/u.test(soakId)) {
    throw new Error(`Invalid T199 soak id: ${soakId}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error(`Invalid T199 workload date: ${date}`);
  }
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Invalid T199 approval index: ${index}`);
  }

  const executionKey = soakId.slice("SSK-".length);
  return `APR-T199-${date.replaceAll("-", "")}-${executionKey}-${index}`;
}
