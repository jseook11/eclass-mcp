export type DoctorClassification = {
  proceed: boolean;
  tolerated: string[];
  blocking: string[];
  warning?: string;
};

const TOLERATED_CHECKS = new Set(['oauth_metadata', 'health_listener']);
const BLOCKING_CHECKS = [
  'profile_parse',
  'profile',
  'tunnel_id',
  'control_plane_api_key',
  'mcp_reachable',
  'runtime_key',
  'api_key_permissions',
];

function failedChecks(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/CHECK\s+(\S+)\s+FAIL/i);
    if (match) out.push(match[1].toLowerCase());
  }
  return out;
}

export function classifyDoctorResult(stdout: string, exitCode: number): DoctorClassification {
  if (exitCode !== 0 && stdout.trim() === '') {
    return {
      proceed: false,
      tolerated: [],
      blocking: ['doctor_unavailable'],
      warning: `tunnel-client doctor를 실행할 수 없습니다(exit ${exitCode}). tunnel-client 설치/PATH를 확인하세요.`,
    };
  }

  const failed = failedChecks(stdout);
  const blocking = failed.filter((check) => BLOCKING_CHECKS.some((blockingCheck) => check.includes(blockingCheck)));
  const tolerated = failed.filter((check) => TOLERATED_CHECKS.has(check) && !blocking.includes(check));

  return {
    proceed: blocking.length === 0,
    tolerated,
    blocking,
  };
}
