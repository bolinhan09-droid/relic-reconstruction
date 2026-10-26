import { el } from '../workspaces/shared.js';

const GUIDE_SEEN = 'relic-api-guide-v1';
const SETTINGS_SEEN = 'relic-api-settings-help-v1';
export const BAILIAN_CONSOLE = 'https://bailian.console.aliyun.com/';
export const BAILIAN_GUIDE = 'https://help.aliyun.com/zh/model-studio/first-api-call-to-qwen?disableWebsiteRedirect=true';

function seen(key) { try { return localStorage.getItem(key) === 'seen'; } catch { return false; } }
function remember(key) { try { localStorage.setItem(key, 'seen'); } catch { /* Optional help still works without storage. */ } }
function ensureStyle() {
  if (document.querySelector('link[data-api-guide]')) return;
  document.head.append(el('link', {rel:'stylesheet', href:new URL('../styles/api-guide.css', import.meta.url).href, 'data-api-guide':''}));
}
export function requestApiGuide() { window.dispatchEvent(new CustomEvent('relic-open-api-guide')); }

/** Optional orientation only: no settings payloads, project writes or model calls. */
export function mountApiGuide({openSettings}) {
  ensureStyle();
  const lifetime = new AbortController();
  const on = (target, event, action) => target?.addEventListener(event, action, {signal:lifetime.signal});
  let step = 0, section = 'assistant', returnFocus = null;
  const closeButton = el('button', {type:'button', class:'ns-button ns-quiet', text:'关闭', 'aria-label':'关闭 API 引导'});
  const count = el('span', {class:'ns-api-guide-count', 'aria-live':'polite'});
  const content = el('section', {class:'ns-api-guide-content', tabindex:'-1'});
  const skip = el('button', {type:'button', class:'ns-button ns-quiet', text:'暂时跳过'});
  const back = el('button', {type:'button', class:'ns-button ns-quiet', text:'上一步'});
  const next = el('button', {type:'button', class:'ns-button ns-primary', text:'下一步'});
  const dialog = el('dialog', {class:'ns-api-guide-dialog', 'aria-labelledby':'apiGuideTitle'},
    el('header', {}, el('div', {}, el('p', {class:'ns-api-guide-eyebrow', text:'首次连接 · 约 30 秒'}), el('h2', {id:'apiGuideTitle', text:'连接你的 AI'})), closeButton),
    el('div', {class:'ns-api-guide-progress'}, count, el('span', {text:'也可以先用示例和本地画笔'})), content,
    el('footer', {}, skip, el('div', {class:'ns-api-guide-navigation'}, back, next)));
  document.body.append(dialog);

  const entry = el('button', {id:'apiGuideButton', type:'button', class:'ns-button ns-quiet ns-api-guide-entry', text:'API 怎么填', dataset:{firstUse:String(!seen(GUIDE_SEEN))}});
  document.getElementById('onboardingOffer')?.append(entry);
  const replay = el('button', {id:'replayApiGuideButton', type:'button', class:'ns-button', text:'查看 API 配置引导'});
  const help = el('div', {class:'ns-help-api'}, el('p', {text:'协作助手和图像生成，统一在顶部的 AI 设置连接'}), replay);
  document.querySelector('#helpDialog .ns-help-practice')?.after(help);

  function dismiss() {
    remember(GUIDE_SEEN); entry.dataset.firstUse = 'false';
    if (dialog.open) dialog.close();
  }
  function configure() { returnFocus = null; dismiss(); openSettings(section); }
  function render() {
    count.textContent = `${step + 1} / 3`; dialog.dataset.step = String(step); back.hidden = step === 0;
    next.textContent = step === 2 ? '去填写 API' : '下一步';
    const note = text => el('p', {class:'ns-api-guide-note', text});
    if (step === 0) {
      content.replaceChildren(el('h3', {text:'入口在左上角'}),
        el('div', {class:'ns-api-guide-location', 'aria-label':'顶部位置示意'}, el('span', {text:'遗迹重构'}), el('strong', {text:'AI 设置'}), el('span', {text:'你的创作'})),
        el('p', {text:'点击顶部的「AI 设置」，配置一次，同类节点就能直接使用。进入工作台后，顶部也有这个入口。'}),
        note('还没有 API 也没关系：可以上传照片、用本地画笔绘制，或先跟着示例做一遍。'));
    } else if (step === 1) {
      const choices = el('div', {class:'ns-api-guide-choices', role:'group', 'aria-label':'选择要连接的用途'});
      for (const [value, title, description] of [
        ['assistant', '协作助手', '一起讨论想法、识别图片、协助执行和审阅'],
        ['image', '图像生成', '生成效果图，把绘制的痕迹融合进衣服']
      ]) {
        const button = el('button', {type:'button', class:'ns-api-guide-choice', 'aria-pressed':String(section === value), dataset:{section:value}}, el('strong', {text:title}), el('span', {text:description}));
        on(button, 'click', () => { section = value; for (const choice of choices.children) choice.setAttribute('aria-pressed', String(choice === button)); });
        choices.append(button);
      }
      content.replaceChildren(el('h3', {text:'先分清两种用途'}), choices,
        note('按需要连接一种或两种。同一平台的 Key 可能通用，但要分别保存到这两个用途；不用在每个节点重复填写。'));
    } else {
      const qwen = el('details', {class:'ns-api-guide-qwen'}, el('summary', {text:'使用千问 / 阿里云百炼'}),
        el('p', {text:section === 'image'
          ? '在「图像生成」选择「千问图像」，填写 API Key 和百炼工作空间 ID。在高级设置中核对地域，Key、工作空间和地域应对应。'
          : '在「协作助手」选择「其他兼容服务」。按百炼官方文档填写对应地域、工作空间的兼容地址和模型名；需要看图时选支持图像理解的模型，不要填图像生成模型。'}),
        el('div', {class:'ns-api-guide-links'},
          el('a', {href:BAILIAN_CONSOLE, target:'_blank', rel:'noopener noreferrer', text:'百炼官方控制台 ↗'}),
          el('a', {href:BAILIAN_GUIDE, target:'_blank', rel:'noopener noreferrer', text:'官方开通与 Key 指南 ↗'})));
      content.replaceChildren(el('h3', {text:section === 'image' ? '连接图像生成' : '连接协作助手'}),
        el('ol', {class:'ns-api-guide-steps'},
          el('li', {text:'在所选服务的官方控制台开通服务，创建 API Key'}),
          el('li', {text:'在 AI 设置选择服务、粘贴 Key，再保存连接'}),
          el('li', {text:'回到节点，点击生成或发送协作请求时才会调用服务'})), qwen,
        note('密钥只用于本次运行，不进入作品或导出文件；重启后需重新填写。保存连接不会自动生成，调用费用由你的服务账户承担。'));
    }
  }
  function open() {
    if (lifetime.signal.aborted) return;
    if (!dialog.open) returnFocus = document.activeElement;
    step = 0; render();
    if (!dialog.open) dialog.showModal();
    next.focus();
  }
  on(entry, 'click', open); on(replay, 'click', open); on(closeButton, 'click', dismiss); on(skip, 'click', dismiss);
  on(back, 'click', () => { step = Math.max(0, step - 1); render(); content.focus(); });
  on(next, 'click', () => { if (step === 2) return configure(); step++; render(); content.focus(); });
  on(dialog, 'cancel', event => { event.preventDefault(); event.stopPropagation(); dismiss(); });
  on(dialog, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); dismiss(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not(:disabled),a[href],summary')].filter(item => item.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === content)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  on(dialog, 'close', () => { const target = returnFocus; returnFocus = null; if (target?.isConnected) target.focus(); });
  on(window, 'relic-open-api-guide', open);
  return {open, dismiss, destroy() { dismiss(); lifetime.abort(); dialog.remove(); entry.remove(); help.remove(); }};
}

/** Inline first-use help lives in the actual settings, without another forced modal. */
export function createApiSettingsHint() {
  ensureStyle();
  const replay = el('button', {type:'button', class:'ns-api-guide-text-button', text:'查看 3 步引导'});
  const element = el('details', {class:'ns-global-api-hint'}, el('summary', {text:'第一次填 API'}),
    el('p', {text:'先选「协作助手」或「图像生成」，再选服务、粘贴 Key 并保存。同类节点自动共用，保存不会开始生成。'}), replay);
  replay.addEventListener('click', requestApiGuide);
  return {element, onOpen() { element.open = !seen(SETTINGS_SEEN); remember(SETTINGS_SEEN); }, destroy() { replay.removeEventListener('click', requestApiGuide); element.remove(); }};
}
