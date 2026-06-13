const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);

if (major !== 24) {
  console.error(
    `[eclass-mcp] Node.js 24가 필요합니다. 현재 버전: ${process.version}\n` +
    '  nvm use 24\n' +
    '  또는 Node 24 환경에서 다시 npm install 을 실행하세요.',
  );
  process.exit(1);
}
