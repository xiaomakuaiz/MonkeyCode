package browser

import (
	"encoding/json"
	"fmt"
	"strings"
)

// snapshotMaxElems 快照元素上限(防 token 爆炸)。与 collectJS 里的 MAX 保持一致。
const snapshotMaxElems = 150

// collectJS 页面内采集脚本:枚举可见的可交互元素(含开放 shadowRoot,
// 跨源 iframe 与 closed shadow root 不支持),元素数组存入
// window.__mcAgentRefs 供第二步取句柄,返回元数据 JSON 字符串。
// window.__mcAgentGen 为页面内代号:导航后归零,交互前用它快速判定 ref 失效。
const collectJS = `(() => {
  const SELS = 'a[href],button,input,select,textarea,summary,[onclick],[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=combobox],[role=option],[role=switch],[contenteditable="true"]';
  const MAX = 150;
  const seen = new Set();
  const els = [];
  let truncated = false;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const collect = (root) => {
    for (const el of root.querySelectorAll(SELS)) {
      if (els.length >= MAX) { truncated = true; return; }
      if (seen.has(el) || !visible(el) || el.disabled) continue;
      seen.add(el);
      els.push(el);
    }
    // 开放 shadowRoot 递归(closed 拿不到,跨源 iframe 不进入)
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) collect(el.shadowRoot);
      if (els.length >= MAX) { truncated = true; return; }
    }
  };
  collect(document);
  window.__mcAgentRefs = els;
  window.__mcAgentGen = (window.__mcAgentGen || 0) + 1;
  const items = els.map((el) => {
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const it = { tag, text };
    const role = el.getAttribute('role');
    if (role) it.role = role;
    if (tag === 'input') it.type = el.type || 'text';
    if (tag === 'a') it.href = (el.getAttribute('href') || '').slice(0, 120);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      it.value = String(el.value ?? '').slice(0, 60);
      if (el.placeholder) it.ph = String(el.placeholder).slice(0, 40);
    }
    if (el.type === 'checkbox' || el.type === 'radio' || role === 'checkbox' || role === 'switch') {
      it.checked = !!el.checked || el.getAttribute('aria-checked') === 'true';
    }
    return it;
  });
  return JSON.stringify({
    url: location.href, title: document.title,
    scrollY: Math.round(scrollY), winH: innerHeight,
    docH: Math.round(document.documentElement.scrollHeight),
    iframes: document.querySelectorAll('iframe').length,
    truncated, gen: window.__mcAgentGen, items,
  });
})()`

// snapshotMeta collectJS 返回的元数据。
type snapshotMeta struct {
	URL       string     `json:"url"`
	Title     string     `json:"title"`
	ScrollY   int        `json:"scrollY"`
	WinH      int        `json:"winH"`
	DocH      int        `json:"docH"`
	Iframes   int        `json:"iframes"`
	Truncated bool       `json:"truncated"`
	Gen       int        `json:"gen"`
	Items     []snapItem `json:"items"`
}

type snapItem struct {
	Tag     string `json:"tag"`
	Text    string `json:"text"`
	Role    string `json:"role,omitempty"`
	Type    string `json:"type,omitempty"`
	Href    string `json:"href,omitempty"`
	Value   string `json:"value,omitempty"`
	PH      string `json:"ph,omitempty"`
	Checked *bool  `json:"checked,omitempty"`
}

// parseSnapshotMeta 解析采集脚本返回的 JSON。
func parseSnapshotMeta(raw string) (*snapshotMeta, error) {
	var m snapshotMeta
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, fmt.Errorf("快照元数据解析失败: %w", err)
	}
	return &m, nil
}

// formatSnapshot 快照文本(给模型):页面信息 + 带 ref 的可交互元素列表。
func formatSnapshot(m *snapshotMeta) string {
	var b strings.Builder
	fmt.Fprintf(&b, "页面: %s\nURL: %s\n", m.Title, m.URL)
	if m.DocH > m.WinH {
		fmt.Fprintf(&b, "滚动: 视口顶部在 %d/%dpx(视口高 %dpx)\n", m.ScrollY, m.DocH, m.WinH)
	}
	fmt.Fprintf(&b, "可交互元素(%d 个):\n", len(m.Items))
	for i, it := range m.Items {
		fmt.Fprintf(&b, "e%d [%s", i+1, it.Tag)
		if it.Type != "" && it.Type != "text" || it.Tag == "input" {
			fmt.Fprintf(&b, ":%s", it.Type)
		}
		if it.Role != "" {
			fmt.Fprintf(&b, " role=%s", it.Role)
		}
		b.WriteString("]")
		if it.Text != "" {
			fmt.Fprintf(&b, " %q", it.Text)
		}
		if it.Value != "" {
			fmt.Fprintf(&b, " 值:%q", it.Value)
		}
		if it.PH != "" {
			fmt.Fprintf(&b, " 占位:%q", it.PH)
		}
		if it.Checked != nil {
			if *it.Checked {
				b.WriteString(" [已勾选]")
			} else {
				b.WriteString(" [未勾选]")
			}
		}
		if it.Href != "" {
			fmt.Fprintf(&b, " → %s", it.Href)
		}
		b.WriteString("\n")
	}
	if m.Truncated {
		fmt.Fprintf(&b, "(元素过多,仅列出前 %d 个;可滚动后重新 snapshot)\n", snapshotMaxElems)
	}
	if m.Iframes > 0 {
		fmt.Fprintf(&b, "(页面含 %d 个 iframe,其内容未包含)\n", m.Iframes)
	}
	return b.String()
}
