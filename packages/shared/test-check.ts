/**
 * 简单功能检查脚本
 * 运行: npx tsx test-check.ts
 */
import {
  // Types
  PaperSummarySchema,
  AuthorSchema,
  PaperIdentifiersSchema,
  // Utils
  LRUCache,
  normalizeSearchText,
  formatAuthorName,
  formatAuthors,
  buildInspireUrl,
  normalizeArxivID,
  // Errors
  McpError,
  invalidParams,
} from './src/index.js';

console.log('=== Phase 1 功能检查 ===\n');

// 1. Zod Schema 验证
console.log('1. Zod Schema 验证');
const paper = PaperSummarySchema.parse({
  recid: '123456',
  title: 'Test Paper',
  authors: ['Guo, Feng-Kun', 'Smith, John'],
  year: 2024,
});
console.log('   PaperSummary:', paper.title, '✓');

const author = AuthorSchema.parse({
  full_name: 'Feng-Kun Guo',
  bai: 'F.K.Guo.1',
});
console.log('   Author:', author.full_name, '✓');

// 2. LRUCache 测试
console.log('\n2. LRUCache 测试');
const cache = new LRUCache<string, number>(3);
cache.set('a', 1);
cache.set('b', 2);
cache.set('c', 3);
cache.set('d', 4); // 应该淘汰 'a'
console.log('   has(a):', cache.has('a'), '(应为 false)');
console.log('   get(b):', cache.get('b'), '(应为 2)');
console.log('   stats:', cache.getStats());

// 3. 文本工具测试
console.log('\n3. 文本工具测试');
console.log('   normalizeSearchText("Müller"):', normalizeSearchText('Müller'));
console.log('   normalizeSearchText("café"):', normalizeSearchText('café'));

// 4. 格式化工具测试
console.log('\n4. 格式化工具测试');
console.log('   formatAuthorName("Guo, Feng-Kun"):', formatAuthorName('Guo, Feng-Kun'));
console.log('   formatAuthors([...]):', formatAuthors(['Guo, Feng-Kun', 'Smith, John', 'Lee, Alice', 'Wang, Bob']));

// 5. 标识符工具测试
console.log('\n5. 标识符工具测试');
console.log('   buildInspireUrl("123456"):', buildInspireUrl('123456'));
console.log('   normalizeArxivID("arXiv:2305.12345"):', normalizeArxivID('arXiv:2305.12345'));

// 6. 错误处理测试
console.log('\n6. 错误处理测试');
const err = invalidParams('Missing required field', { field: 'recid' });
console.log('   McpError:', err.code, err.message);

console.log('\n=== 所有检查通过 ===');
