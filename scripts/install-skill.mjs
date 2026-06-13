#!/usr/bin/env node
/**
 * eclass-cau 스킬을 Claude Code가 인식하도록 설치한다.
 * ~/.claude/skills/eclass-cau 를 이 repo의 skills/eclass-cau 로 심볼릭 링크한다.
 * 사용: npm run install:skill
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const source = path.join(repoRoot, 'skills', 'eclass-cau');
const skillsDir = path.join(os.homedir(), '.claude', 'skills');
const target = path.join(skillsDir, 'eclass-cau');

async function main() {
  // 원본 스킬 디렉토리 존재 확인
  try {
    await fs.access(path.join(source, 'SKILL.md'));
  } catch {
    console.error(`[install:skill] 스킬을 찾을 수 없습니다: ${source}`);
    process.exit(1);
  }

  await fs.mkdir(skillsDir, { recursive: true });

  // 이미 존재하면 어떤 상태인지 안내만 하고 멈춘다 (덮어쓰기 강제 안 함)
  let existing;
  try {
    existing = await fs.lstat(target);
  } catch {
    existing = null;
  }

  if (existing) {
    if (existing.isSymbolicLink()) {
      const dest = await fs.readlink(target);
      if (path.resolve(skillsDir, dest) === source) {
        console.log(`[install:skill] 이미 설치돼 있습니다: ${target} -> ${source}`);
        return;
      }
      console.error(`[install:skill] ${target} 가 다른 곳을 가리키는 심볼릭 링크입니다: ${dest}`);
    } else {
      console.error(`[install:skill] ${target} 가 이미 존재합니다 (심볼릭 링크 아님).`);
    }
    console.error('  먼저 해당 경로를 정리한 뒤 다시 실행하세요.');
    process.exit(1);
  }

  await fs.symlink(source, target, 'dir');
  console.log(`[install:skill] 설치 완료: ${target} -> ${source}`);
  console.log('  Claude Code를 재시작하면 eclass-cau 스킬이 활성화됩니다.');
}

main().catch((err) => {
  console.error('[install:skill] 실패:', err);
  process.exit(1);
});
