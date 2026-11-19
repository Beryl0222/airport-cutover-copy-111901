// 规则式双语解析：不做翻译，只把旅客原话拆成目标、无障碍要求与位置线索。
// 位置线索只描述“旅客自称看到什么”，是否采信由会话状态机按规则处理。
const KEYWORDS = {
  target: {
    zh: ['地面巴士', '巴士', '接驳', '大巴'],
    en: ['coach', 'coaches', 'ground transport', 'shuttle', 'bus'],
  },
  hardStepFree: {
    // 明确要求全程无阶差
    zh: ['全程无阶差', '无阶差', '不能有台阶', '不要台阶', '轮椅', '无障碍'],
    en: ['no steps', 'step-free', 'step free', 'without steps', 'wheelchair', 'step free access'],
  },
  softAvoidEscalator: {
    // 带行李、尽量避开扶梯：是偏好不是硬约束
    zh: ['避开扶梯', '不想坐扶梯', '尽量别用扶梯', '别用扶梯', '行李'],
    en: ['avoid the escalator', 'avoid escalator', 'with luggage', 'have luggage', 'luggage'],
  },
  stairsHard: {
    // “不能走楼梯”按硬性无阶差处理
    zh: ['不能走楼梯', '走不了楼梯', '不能爬楼'],
    en: ['cannot use stairs', "can't use stairs", 'no stairs', 'cannot climb stairs'],
  },
  lift: {
    zh: ['电梯'],
    en: ['lift', 'elevator'],
  },
  escalator: {
    zh: ['扶梯'],
    en: ['escalator'],
  },
  gate: {
    zh: ['闸口', '闸', '隔离闸'],
    en: ['gate'],
  },
  help: {
    zh: ['服务台', '求助', '工作人员'],
    en: ['help desk', 'staff', 'assistance'],
  },
  coachSymbol: {
    zh: ['巴士图案', '巴士标志', '巴士标识'],
    en: ['coach symbol', 'coach sign', 'bus symbol', 'bus icon'],
  },
};

const UNCERTAIN = {
  zh: ['不确定', '不太确定', '好像', '应该', '也许', '可能', '不知道有没有'],
  en: ['not sure', "i'm not sure", 'unsure', 'maybe', 'perhaps', 'might have'],
};

const LEVEL_PATTERNS = [
  { lang: 'zh', re: /([一二两12])\s*层/, normalize: (m) => (m[1] === '一' || m[1] === '1' ? 1 : 2) },
  { lang: 'en', re: /level\s*([12])/i, normalize: (m) => Number(m[1]) },
  { lang: 'en', re: /\bL([12])\b/i, normalize: (m) => Number(m[1]) },
];

function containsAny(haystack, words) {
  const lower = haystack.toLowerCase();
  return words.some((word) => lower.includes(word.toLowerCase()));
}

function detectLang(text) {
  return /[㐀-鿿]/.test(text) ? 'zh' : 'en';
}

// 提取标牌编号，如 D14、r3（输出统一大写）。
function extractSignIds(text) {
  return [...text.matchAll(/\b([A-Za-z]\d{1,3})\b/g)].map((match) => match[1].toUpperCase());
}

// 从资料标牌文字反查编号，同名会返回多个。
function signsBySpokenName(model, lang, text) {
  const lower = text.toLowerCase();
  return [...model.signs.values()].filter((sign) => {
    if (lang === 'zh') return text.includes(sign.zh);
    return lower.includes(sign.en.toLowerCase());
  });
}

export function parseUtterance(rawText, model) {
  const text = rawText.trim();
  const lang = detectLang(text);
  const lower = text.toLowerCase();
  const result = {
    rawText,
    lang,
    target: null,
    accessibility: null, // 'hardStepFree' | 'softAvoidEscalator' | null
    clues: [],
    gateClaim: null, // { passed: boolean, uncertain: boolean }
    askedHelp: false,
  };

  // 目的地：资料里“地面巴士/Coach”对应 T18。
  if (containsAny(text, KEYWORDS.target[lang])) {
    const matches = model.findByText(lang === 'zh' ? '地面巴士' : 'Coach');
    result.target = matches[0]?.id ?? null;
  }

  // 无障碍：硬约束优先于软偏好。
  if (
    containsAny(text, KEYWORDS.hardStepFree[lang]) ||
    containsAny(text, KEYWORDS.stairsHard[lang])
  ) {
    result.accessibility = 'hardStepFree';
  } else if (containsAny(text, KEYWORDS.softAvoidEscalator[lang])) {
    result.accessibility = 'softAvoidEscalator';
  }

  if (containsAny(text, KEYWORDS.help[lang])) result.askedHelp = true;

  const uncertain = containsAny(text, UNCERTAIN[lang]);

  // 楼层数字线索。
  for (const pattern of LEVEL_PATTERNS) {
    const match = text.match(pattern.re);
    if (match) {
      result.clues.push({ type: 'level', level: pattern.normalize(match), uncertain });
      break;
    }
  }

  // 标牌编号：亲眼读到编号是最强的位置证据。
  for (const id of extractSignIds(text)) {
    if (model.signs.has(id)) {
      result.clues.push({ type: 'signId', signId: id, uncertain });
    }
  }

  // “巴士图案/coach symbol”：资料里只有一层的东换乘与巴士同区，按楼层 1 作线索，不直接当确认。
  if (containsAny(text, KEYWORDS.coachSymbol[lang])) {
    result.clues.push({ type: 'coachSymbol', level: 1, uncertain });
  }

  // 按现场挂牌文字反查（可能同名多个，保留全部）。
  // 目的地标牌（如旅客说“要去地面巴士/Coach”）不是位置线索，必须排除，
  // 否则会把“想去哪”误当成“已经在哪”。
  const named = signsBySpokenName(model, lang, text).filter(
    (sign) => sign.id !== result.target,
  );
  for (const sign of named) {
    if (!result.clues.some((clue) => clue.type === 'signId' && clue.signId === sign.id)) {
      result.clues.push({
        type: 'signName',
        signId: sign.id,
        sameNameCount: model.sameNameGroup(sign.id).length,
        uncertain,
      });
    }
  }

  // “没开门的那个/the closed one”：结合当前封闭记录解析为受影响通道的端点。
  const closedWords = lang === 'zh' ? ['没开门', '关着', '关闭', '封了', '不开'] : ['closed', 'shut', 'not open'];
  if (containsAny(text, closedWords)) {
    for (const [corridorId, closureIds] of model.closedBy) {
      const corridor = model.corridors.get(corridorId);
      result.clues.push({
        type: 'closedLandmark',
        corridorId,
        nearSign: corridor.from,
        closureIds: [...closureIds],
        uncertain,
      });
    }
  }

  // 闸口通过声明：三态——明确已过、明确未过、不确定。不确定时系统不得代认。
  const gateMentioned = containsAny(text, KEYWORDS.gate[lang]);
  if (gateMentioned) {
    const passedWords = lang === 'zh'
      ? ['过了闸', '过闸', '已经过', '过了']
      : ['passed', 'went through', 'through the gate'];
    const negatedWords = lang === 'zh'
      ? ['没过闸', '还没过', '没有过', '没过']
      : ["haven't passed", 'have not passed', 'not passed', "haven't gone through", 'before the gate'];
    const passed = containsAny(text, passedWords);
    const negated = containsAny(text, negatedWords);
    result.gateClaim = {
      passed: passed && !negated,
      negated,
      uncertain: uncertain || (!passed && !negated),
    };
  }

  return result;
}
