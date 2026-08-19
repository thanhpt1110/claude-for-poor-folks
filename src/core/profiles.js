/**
 * Task profiles. A profile is a named cost expectation for a kind of work.
 *
 * Two things make this list extensible, because no fixed list is ever complete:
 *   1. `custom` profiles can be added in .poor-folks.json (same shape).
 *   2. `other` accepts a free-text label and falls back to the default budget.
 *
 * budgetUsd     - soft ceiling for one session of this kind of work
 * burnUsdPerMin - "too fast" threshold; catches runaway loops long before the cap
 * ctxWarnPct    - context fill % at which compaction (an expensive event) is near
 * keywords      - a map of language tag -> phrases. Any tag works; the two below
 *                 are simply the ones that ship. Adding a language is a pull
 *                 request with one more key, and detection picks it up with no
 *                 code change.
 */

/** @type {import('../types.js').Profiles} */
export const BUILTIN_PROFILES = {
  discuss: {
    id: 'discuss',
    label: 'Discuss / brainstorm',
    budgetUsd: 0.2,
    burnUsdPerMin: 0.15,
    ctxWarnPct: 80,
    hint: 'Talking, planning, comparing options. Should stay cheap; if it does not, the agent is reading code it was not asked to read.',
    keywords: {
      en: ['brainstorm', 'discuss', 'ideas', 'opinion', 'compare', 'should i', 'what do you think', 'pros and cons', 'explain', 'question'],
      vi: ['brainstorm', 'thảo luận', 'thao luan', 'bàn', 'ban bac', 'ý kiến', 'y kien', 'so sánh', 'so sanh', 'nên chọn', 'nen chon', 'giải thích', 'giai thich', 'tư vấn', 'tu van', 'discuss']
    }
  },
  bugfix: {
    id: 'bugfix',
    label: 'Small bug fix',
    budgetUsd: 0.5,
    burnUsdPerMin: 0.3,
    ctxWarnPct: 75,
    hint: 'One defect, known file. Wide context here is a smell.',
    keywords: {
      en: ['fix', 'bug', 'broken', 'error', 'crash', 'exception', 'stack trace', 'not working', 'regression', 'traceback'],
      vi: ['sửa lỗi', 'sua loi', 'lỗi', 'loi', 'fix', 'hỏng', 'hong', 'không chạy', 'khong chay', 'bị lỗi', 'bi loi', 'crash', 'sai']
    }
  },
  feature: {
    id: 'feature',
    label: 'New feature',
    budgetUsd: 1.5,
    burnUsdPerMin: 0.5,
    ctxWarnPct: 80,
    hint: 'Add something new across a few files.',
    keywords: {
      en: ['add', 'implement', 'build', 'create', 'feature', 'endpoint', 'support for', 'new page', 'new command'],
      vi: ['thêm', 'them', 'viết', 'viet', 'tạo', 'tao', 'xây dựng', 'xay dung', 'triển khai', 'trien khai', 'tính năng', 'tinh nang', 'chức năng', 'chuc nang', 'làm cái', 'lam cai']
    }
  },
  refactor: {
    id: 'refactor',
    label: 'Refactor / migration',
    budgetUsd: 4.0,
    burnUsdPerMin: 0.8,
    ctxWarnPct: 85,
    hint: 'The most expensive kind of work. Wide reads are legitimate here, so the cap matters more than the burn rate.',
    keywords: {
      en: ['refactor', 'migrate', 'rewrite', 'restructure', 'rename across', 'upgrade to', 'port to', 'modernize', 'clean up the whole'],
      vi: ['refactor', 'tái cấu trúc', 'tai cau truc', 'viết lại', 'viet lai', 'chuyển đổi', 'chuyen doi', 'nâng cấp', 'nang cap', 'migrate', 'dọn dẹp toàn bộ', 'don dep toan bo']
    }
  },
  test: {
    id: 'test',
    label: 'Run / fix tests, CI',
    budgetUsd: 1.0,
    burnUsdPerMin: 0.5,
    ctxWarnPct: 75,
    hint: 'The classic loop trap: run tests, fail, tweak, run again. Burn rate is the signal that matters.',
    keywords: {
      en: ['run test', 'tests fail', 'unit test', 'pytest', 'jest', 'ci is red', 'make it pass', 'coverage', 'flaky'],
      vi: ['chạy test', 'chay test', 'test', 'kiểm thử', 'kiem thu', 'ci đỏ', 'ci do', 'cho pass', 'chạy ci', 'chay ci']
    }
  },
  research: {
    id: 'research',
    label: 'Research / read the codebase',
    budgetUsd: 1.0,
    burnUsdPerMin: 0.4,
    ctxWarnPct: 85,
    hint: 'Reading is the point, so context grows fast and legitimately. Watch the cap, not the width.',
    keywords: {
      en: ['how does', 'where is', 'find', 'search', 'investigate', 'trace', 'understand', 'audit', 'why does', 'walk me through'],
      vi: ['tìm hiểu', 'tim hieu', 'ở đâu', 'o dau', 'tại sao', 'tai sao', 'giải thích code', 'giai thich code', 'đọc code', 'doc code', 'điều tra', 'dieu tra', 'phân tích', 'phan tich', 'tìm', 'tim']
    }
  },
  review: {
    id: 'review',
    label: 'Code review',
    budgetUsd: 0.8,
    burnUsdPerMin: 0.4,
    ctxWarnPct: 80,
    hint: 'Bounded by the diff. If cost climbs past the diff size, the agent has wandered.',
    keywords: {
      en: ['review', 'code review', 'look at this pr', 'critique', 'is this correct', 'security review', 'check my'],
      vi: ['review', 'xem lại', 'xem lai', 'kiểm tra code', 'kiem tra code', 'đánh giá', 'danh gia', 'soi', 'nhận xét', 'nhan xet']
    }
  },
  docs: {
    id: 'docs',
    label: 'Docs / writing',
    budgetUsd: 0.3,
    burnUsdPerMin: 0.2,
    ctxWarnPct: 70,
    hint: 'Cheap by nature. Cost here almost always means unnecessary code reading.',
    keywords: {
      en: ['readme', 'document', 'docs', 'changelog', 'write up', 'comment', 'docstring', 'release notes'],
      vi: ['tài liệu', 'tai lieu', 'viết doc', 'viet doc', 'readme', 'ghi chú', 'ghi chu', 'changelog', 'hướng dẫn', 'huong dan']
    }
  },
  ops: {
    id: 'ops',
    label: 'Setup / deploy / infra',
    budgetUsd: 1.0,
    burnUsdPerMin: 0.4,
    ctxWarnPct: 75,
    hint: 'Long tool chains, little reading. Retry loops on failing commands are the risk.',
    keywords: {
      en: ['deploy', 'docker', 'kubernetes', 'k8s', 'terraform', 'install', 'configure', 'set up', 'ci pipeline', 'systemd', 'nginx'],
      vi: ['triển khai', 'trien khai', 'deploy', 'cài đặt', 'cai dat', 'cấu hình', 'cau hinh', 'dựng', 'dung server', 'docker', 'hạ tầng', 'ha tang']
    }
  },
  data: {
    id: 'data',
    label: 'Data / SQL / analysis',
    budgetUsd: 0.8,
    burnUsdPerMin: 0.4,
    ctxWarnPct: 80,
    hint: 'Query results are the token sink. Big result sets belong in a file, not in context.',
    keywords: {
      en: ['sql', 'query', 'dataset', 'dataframe', 'analyze the data', 'csv', 'bigquery', 'chart', 'aggregate'],
      vi: ['truy vấn', 'truy van', 'sql', 'dữ liệu', 'du lieu', 'phân tích số liệu', 'phan tich so lieu', 'bảng', 'bang', 'thống kê', 'thong ke', 'biểu đồ', 'bieu do']
    }
  },
  other: {
    id: 'other',
    label: 'Other (free text)',
    budgetUsd: 1.0,
    burnUsdPerMin: 0.5,
    ctxWarnPct: 80,
    hint: 'Anything the list does not cover. Give it a name and it is remembered for this repo.',
    keywords: { en: [], vi: [] }
  }
};

export const DEFAULT_PROFILE_ID = 'other';

/**
 * Merge built-ins with user-defined profiles from config. User wins on id clash.
 * @param {Record<string, Partial<import('../types.js').Profile>>} [customProfiles]
 * @returns {import('../types.js').Profiles}
 */
export function resolveProfiles(customProfiles = {}) {
  /** @type {import('../types.js').Profiles} */
  const out = { ...BUILTIN_PROFILES };
  for (const [id, p] of Object.entries(customProfiles || {})) {
    out[id] = { ...(BUILTIN_PROFILES[id] ?? BUILTIN_PROFILES.other), ...p, id };
  }
  return out;
}

/**
 * @param {import('../types.js').Profiles} profiles
 * @param {string|null|undefined} id
 * @returns {import('../types.js').Profile}
 */
export function getProfile(profiles, id) {
  return (id ? profiles[id] : undefined) ?? profiles[DEFAULT_PROFILE_ID] ?? BUILTIN_PROFILES.other;
}
