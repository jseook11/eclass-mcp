import test from 'node:test';
import assert from 'node:assert/strict';

import { parseModulebuilderItems } from '../src/resource-items.js';

const notStartedModulebuilderResponse = [
  {
    module_id: 793625,
    title: '1주차',
    unlock_at: '2026-09-03T15:00:00Z',
    module_items: [
      {
        module_item_id: 3707021,
        title: 'algorithm_01.1_introduction',
        content_data: {
          item_content_type: 'commons',
          lecture_period_status: 'not_open',
          unlock_at: '2026-09-03T15:00:00Z',
          item_content_data: {
            content_id: 'not_open',
            content_type: 'movie',
          },
        },
      },
    ],
  },
];

test('parseModulebuilderItems omits materials before the learning period starts', () => {
  assert.deepEqual(parseModulebuilderItems(notStartedModulebuilderResponse), []);
});

test('parseModulebuilderItems keeps available items and omits future-period placeholders', () => {
  const result = parseModulebuilderItems([
    {
      title: '1주차',
      module_items: [
        ...notStartedModulebuilderResponse[0].module_items,
        {
          module_item_id: 3707022,
          title: 'available.pdf',
          content_data: {
            item_content_type: 'commons',
            lecture_period_status: 'open',
            item_content_data: {
              content_id: 'available-content',
              content_type: 'pdf',
            },
          },
        },
      ],
    },
  ]);

  assert.deepEqual(result, [{
    id: '3707022',
    title: 'available.pdf',
    url: 'https://ocs.cau.ac.kr/em/available-content',
    type: 'pdf',
  }]);
});
