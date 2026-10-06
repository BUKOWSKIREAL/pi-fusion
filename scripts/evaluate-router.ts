import { mkdirSync, writeFileSync } from 'node:fs';
import { routeWithJev, type RouteChoice } from '../src/router.ts';

const cases: Array<{ request: string; expected: RouteChoice }> = [
  { request: '设计一个支持多租户的权限模型，比较 RBAC 和 ABAC 后选择方案。', expected: 'lead' },
  { request: '按已经确定的方案，把 auth.ts 的 parseToken 拆到 token.ts，保持签名和行为不变，更新导入，运行 npm test -- token.test.ts，然后返回 diff 和日志。', expected: 'sidekick' },
  { request: '帮我查线上数据库，自己写 SQL 算上周活跃用户，解释口径。', expected: 'lead' },
  { request: '运行我已审定的 queries/weekly-active.sql，不改查询；遇到缺表立即汇报，返回原始结果。', expected: 'sidekick' },
  { request: '继续做刚才那个。', expected: 'uncertain' },
  { request: '审查这个登录修复的完整 diff，判断是否存在鉴权绕过。', expected: 'lead' },
  { request: '在 src/ 和 tests/ 全量查找旧 API getUserInfo 的引用，给出路径和行号，不修改代码。', expected: 'sidekick' },
  { request: '提交修改并创建 PR，回复 reviewer 的问题。', expected: 'lead' },
  { request: '运行 pnpm --filter api test -- auth.test.ts 并整理失败日志，不改变测试或实现。', expected: 'sidekick' },
  { request: '编写评测评分规则，并决定哪些失败应该扣多少分。', expected: 'lead' },
];
const results: unknown[] = [];
for (let i = 0; i < cases.length; i += 2) {
  const batch = await Promise.all(cases.slice(i, i + 2).map(async sample => ({ ...sample, result: await routeWithJev(sample.request) })));
  results.push(...batch);
  console.log(JSON.stringify(batch));
}
mkdirSync(new URL('../evaluation/', import.meta.url), { recursive: true });
writeFileSync(new URL('../evaluation/jev-routing.json', import.meta.url), JSON.stringify({
  evaluatedAt: new Date().toISOString(), note: 'Synthetic smoke sample only; no workflow accuracy or cost-savings claim. Only synthetic requests were sent.', results,
}, null, 2) + '\n');
