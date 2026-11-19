// 文案渲染：同一动作输出手机长文案与小屏分步短文案。
// 长度按 Unicode 码点计算（Array.from）。
// 地标一律引用资料中的现场挂牌文字或标牌编号，不自造译名。
import { t } from './i18n.mjs';

export function codePointLength(text) {
  return Array.from(text).length;
}

function signLabel(model, signId, lang) {
  const sign = model.sign(signId);
  return { id: sign.id, level: sign.level, text: sign[lang], fallback: `${sign.id} ${sign[lang]}` };
}

function closureText(model, reason, lang) {
  if (reason?.type !== 'closed') return '';
  const closureId = reason.closureIds?.[0];
  const notice = closureId ? model.closureNotices.get(closureId)?.notice : null;
  // 运行说明只有一种语言时不翻译，改报编号，避免自造译名。
  if (lang === 'zh' && notice) return notice;
  return t(lang, 'closureReason', reason.corridorId);
}

function warningsText(model, response, lang) {
  const lines = [];
  for (const warning of response.warnings ?? []) {
    if (warning === 'noStepFreeRoute') lines.push(t(lang, 'noStepFreeRoute'));
    if (warning === 'onewayGateAhead') lines.push(t(lang, 'gatePassedNotice'));
    if (warning === 'softAvoidHonored') lines.push(t(lang, 'softAvoidNotice'));
    if (warning === 'softAvoidUnavoidable') lines.push(t(lang, 'softAvoidUnavoidable'));
  }
  return lines;
}

// 手机文案：可容纳地标与原因，单条控制在 channel.max 内。
export function renderPhone(model, response) {
  const lang = response.lang;
  const parts = [];

  if (response.cancelled) {
    parts.push(t(lang, 'cancelText', response.cancelled.reason.corridorId ?? ''));
    const reasonText = closureText(model, response.cancelled.reason, lang);
    if (reasonText) parts.push(reasonText);
    parts.push(t(lang, 'replacement'));
  }

  if (response.kind === 'instruction') {
    const label = signLabel(model, response.action.signId, lang);
    const head = lang === 'zh'
      ? `${t(lang, 'goto', label.text)}（${label.id}，${t(lang, 'floorWord', label.level)}）`
      : `${t(lang, 'goto', label.text)} (${label.id}, ${t(lang, 'floorWord', label.level)})`;
    parts.push(head);
    parts.push(t(lang, 'via', response.action.corridorId));
    parts.push(...warningsText(model, response, lang));
  } else if (response.kind === 'question') {
    parts.push(questionText(model, response, lang));
  } else if (response.kind === 'help') {
    const label = signLabel(model, response.action.signId, lang);
    parts.push(
      response.route
        ? lang === 'zh'
          ? `${t(lang, 'askHelp', label.text)}（${label.id}，${t(lang, 'floorWord', label.level)}）`
          : `${t(lang, 'askHelp', label.text)} (${label.id}, ${t(lang, 'floorWord', label.level)})`
        : t(lang, 'stay', label.text),
    );
  } else if (response.kind === 'arrived') {
    const label = signLabel(model, response.action.signId, lang);
    parts.push(t(lang, 'arrived', label.text));
  }

  return parts.filter(Boolean).join('；').replace(/；$/, '');
}

function questionText(model, response, lang) {
  if (response.questionCode === 'same-name-sign' && response.candidates) {
    const lines = [t(lang, 'disambigTitle')];
    for (const id of response.candidates) {
      lines.push(t(lang, 'disambigItem', model.sign(id), model.sign(id).level));
    }
    return lines.join(' ');
  }
  if (response.questionCode === 'oneway-gate') return t(lang, 'onewayQuestion');
  if (response.questionCode === 'first-step-diverges' && response.candidates) {
    const edges = response.candidates.map((edgeId) => {
      const edge = model.corridors.get(edgeId);
      const label = signLabel(model, edge.to, lang);
      return `${label.id} ${label.text}`;
    });
    return `${t(lang, 'disambigTitle')} ${edges.join(' / ')}`;
  }
  if (response.questionCode === 'need-target') {
    return lang === 'zh' ? '您要去哪种交通方式？' : 'Which transport do you need?';
  }
  return lang === 'zh'
    ? '请告诉我您现在看到的标牌编号或文字。'
    : 'Please tell me the sign ID or text you can see now.';
}

// 渠道语言：small-zh / small-en 固定语种；phone 跟随会话语言。
function channelLang(channelId, fallback) {
  if (channelId.endsWith('-zh')) return 'zh';
  if (channelId.endsWith('-en')) return 'en';
  return fallback;
}

function withLang(response, lang) {
  return response.lang === lang ? response : { ...response, lang };
}

// 小屏：只能分步。每个片段都必须满足预算；先按语义拆分，仍超长则退化到编号。
export function renderSmallScreen(model, response, max) {
  const lang = response.lang;
  const segments = [];

  if (response.cancelled) {
    segments.push(t(lang, 'cancelTextShort', response.cancelled.reason.corridorId ?? ''));
  }

  if (response.kind === 'instruction') {
    const label = signLabel(model, response.action.signId, lang);
    segments.push(t(lang, 'goto', label.text));
    segments.push(`${label.id} · ${t(lang, 'floorWord', label.level)}`);
    segments.push(t(lang, 'via', response.action.corridorId));
    // 影响无障碍的事实必须保留在小屏上。
    if ((response.warnings ?? []).includes('noStepFreeRoute')) {
      segments.push(t(lang, 'noStepFreeRoute'));
    }
    if ((response.warnings ?? []).includes('onewayGateAhead')) {
      segments.push(t(lang, 'gatePassedNotice'));
    }
    if ((response.warnings ?? []).includes('softAvoidUnavoidable')) {
      segments.push(t(lang, 'softAvoidUnavoidable'));
    }
  } else if (response.kind === 'question') {
    if (response.questionCode === 'same-name-sign' && response.candidates) {
      segments.push(t(lang, 'whichLevel', model.sign(response.candidates[0]).zh));
      for (const id of response.candidates) {
        segments.push(t(lang, 'disambigItem', model.sign(id), model.sign(id).level));
      }
    } else {
      segments.push(questionText(model, response, lang));
    }
  } else if (response.kind === 'help') {
    const label = signLabel(model, response.action.signId, lang);
    segments.push(t(lang, 'askHelp', label.text));
    segments.push(`${label.id} · ${t(lang, 'floorWord', label.level)}`);
  } else if (response.kind === 'arrived') {
    const label = signLabel(model, response.action.signId, lang);
    segments.push(t(lang, 'arrived', label.text));
  }

  return segments.flatMap((segment) => fitSegment(segment, max, lang, model));
}

function fitSegment(segment, max, lang, model) {
  if (codePointLength(segment) <= max) return [segment];
  // 先尝试按标点/空格切分。
  const pieces = segment.split(/[；;。:：]\s*|\s{2,}|\s-\s/).filter(Boolean);
  const out = [];
  for (const piece of pieces) {
    if (codePointLength(piece) <= max) {
      out.push(piece);
      continue;
    }
    // 找不到该语言下不易误认的短说法时，只保留资料里的标牌编号（可回查、不自造译名）。
    const ids = [...piece.matchAll(/[A-Z]\d{1,3}/g)].map((m) => m[0]);
    if (ids.length) {
      out.push(...ids);
    } else {
      // 编号也没有时宁可标记待值班员处理，也不输出被截断、可能误导方向的半句话。
      out.push(lang === 'zh' ? '内容过长，请询服务台' : 'Too long. Ask Help Desk.');
    }
  }
  return out.filter((item) => codePointLength(item) <= max);
}

export function renderForChannel(model, response, channel) {
  const lang = channelLang(channel.id, response.lang);
  const localized = withLang(response, lang);
  if (channel.id === 'phone') {
    const text = renderPhone(model, localized);
    return { channel: channel.id, lang, fits: codePointLength(text) <= channel.max, text, segments: null };
  }
  const segments = renderSmallScreen(model, localized, channel.max);
  return {
    channel: channel.id,
    lang,
    fits: segments.every((segment) => codePointLength(segment) <= channel.max),
    text: null,
    segments,
  };
}
