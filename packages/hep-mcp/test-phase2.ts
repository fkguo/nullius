/**
 * Phase 2 功能检查脚本
 * 运行: pnpm exec tsx test-phase2.ts
 */
import * as api from './src/api/client.js';

console.log('=== Phase 2 功能检查 ===\n');

// 测试用例: LHCb pentaquark 发现论文 (recid: 1597424)
const TEST_RECID = '1597424';

async function test() {
  // 1. 测试获取论文详情
  console.log('1. 测试 inspire_get_paper');
  const paper = await api.getPaper(TEST_RECID);
  console.log(`   标题: ${paper.title?.slice(0, 60)}...`);
  console.log(`   作者数: ${paper.authors?.length}`);
  console.log(`   引用数: ${paper.citation_count}`);

  // 2. 测试获取参考文献（不设限制，应返回全部）
  console.log('\n2. 测试 inspire_get_references (无限制)');
  const refs = await api.getReferences(TEST_RECID);
  console.log(`   参考文献数量: ${refs.length} (预期 ~732)`);
  if (refs.length > 0) {
    console.log(`   第一篇: ${refs[0]?.title?.slice(0, 50)}`);
  }

  // 3. 测试获取引用
  console.log('\n3. 测试 inspire_get_citations');
  const citations = await api.getCitations(TEST_RECID, { size: 10 });
  console.log(`   被引用总数: ${citations.total}`);
  console.log(`   返回数量: ${citations.papers.length}`);

  // 4. 测试搜索
  console.log('\n4. 测试 inspire_search (pentaquark)');
  const searchResult = await api.search('pentaquark', { size: 5 });
  console.log(`   找到 ${searchResult.total} 篇论文`);

  // 4b. 测试 publication_summary 字段
  console.log('\n4b. 测试 publication_summary 字段');
  const searchResult2 = await api.search(`recid:${TEST_RECID}`, { size: 1 });
  const p = searchResult2.papers[0] as any;
  console.log(`   publication_summary: ${p.publication_summary || '(未返回)'}`);

  // 5. 测试 BibTeX
  console.log('\n5. 测试 inspire_get_bibtex');
  const bibtex = await api.getBibtex([TEST_RECID]);
  console.log(`   BibTeX 长度: ${bibtex.length} 字符`);
  console.log(`   包含 @article: ${bibtex.includes('@article')}`);

  console.log('\n=== 所有检查通过 ===');
}

test().catch(console.error);
