// 固定界面句式。zh/en 两套；地标名称不在这里造词，全部取自 data 里的标牌文字。
export const LANGS = ['zh', 'en'];

const STRINGS = {
  zh: {
    goto: (target) => `朝${target}走`,
    via: (corridor) => `经通道${corridor}`,
    arrived: (target) => `已到达${target}`,
    stay: (place) => `请在${place}原地等候工作人员`,
    askHelp: (place) => `请到${place}求助`,
    disambigTitle: '请确认您实际看到的是哪一个：',
    disambigItem: (sign, level) => `${sign.id} ${sign.zh}（${level}层）`,
    whichLevel: (name) => `您看到的「${name}」在哪一层？`,
    onewayQuestion: '前方是只能单向通过的闸口，您是否已经通过？',
    closureReason: (corridorId) => `通道${corridorId}临时关闭`,
    noStepFreeRoute: '当前楼层没有全程无阶差路线',
    softAvoidNotice: '已为您避开扶梯；如需全程无阶差请明确告知',
    softAvoidUnavoidable: '本步无法避开扶梯，全程无阶差需另行安排',
    prefixClosed: '【取消上一条】',
    cancelText: (corridorId) => `上一条指引经过的通道${corridorId}现已关闭，请勿继续按旧指引走。`,
    cancelTextShort: (corridorId) => `旧指引作废：通道${corridorId}已关闭`,
    replacement: '替代路线：',
    floorWord: (level) => `${level}层`,
    gatePassedNotice: '闸口单向，无法原路返回',
  },
  en: {
    goto: (target) => `Head to ${target}`,
    via: (corridor) => `via corridor ${corridor}`,
    arrived: (target) => `You have reached ${target}`,
    stay: (place) => `Please stay at ${place} and wait for staff`,
    askHelp: (place) => `Go to ${place} for help`,
    disambigTitle: 'Please confirm which one you actually see:',
    disambigItem: (sign, level) => `${sign.id} ${sign.en} (Level ${level})`,
    whichLevel: (name) => `Which level is the "${name}" you see?`,
    onewayQuestion: 'A one-way gate is ahead. Have you already passed through it?',
    closureReason: (corridorId) => `Corridor ${corridorId} is temporarily closed`,
    noStepFreeRoute: 'No fully step-free route exists on this level',
    softAvoidNotice: 'Escalators avoided where possible; ask explicitly for fully step-free if needed',
    softAvoidUnavoidable: 'This step cannot avoid the escalator; fully step-free needs separate arrangement',
    prefixClosed: '[PREVIOUS ADVICE CANCELLED] ',
    cancelText: (corridorId) => `The previous route used corridor ${corridorId}, now closed. Do not follow the old instruction.`,
    cancelTextShort: (corridorId) => `Old advice void: corridor ${corridorId} closed`,
    replacement: 'New route: ',
    floorWord: (level) => `Level ${level}`,
    gatePassedNotice: 'One-way gate. No return.',
  },
};

export function t(lang, key, ...args) {
  const dict = STRINGS[lang] ?? STRINGS.zh;
  const value = dict[key];
  return typeof value === 'function' ? value(...args) : value;
}
