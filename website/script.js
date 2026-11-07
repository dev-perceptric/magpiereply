// MagpieReply website: pixel mosaics, tab groups, the phone menu,
// the pricing period switch and the integrations filter.

(function () {
  const BRAND = [9, 67, 176];
  const WHITE = [255, 255, 255];
  const CELL = 10;
  const GAP = 2;

  // Where each mosaic puts its squares: a weight from 0 to 1 for a point (x, y) in 0..1.
  const LAYOUTS = {
    hero: (x, y) => Math.max(0, (x - 0.55) / 0.45) ** 1.6 * (1 - y * 0.35) + Math.max(0, (0.12 - x) / 0.12) * 0.55,
    corners: (x, y) => Math.max(Math.max(0, 1 - (x + y) / 0.38), Math.max(0, 1 - (2 - x - y) / 0.38)) ** 1.4,
    band: (x) => Math.max(Math.max(0, (0.1 - x) / 0.1), Math.max(0, (x - 0.9) / 0.1)) ** 1.2,
    oss: (x, y) => Math.max(0, (x - 0.7) / 0.3) ** 1.8 * y,
    cta: (x, y) => Math.max(0, (x - 0.5) / 0.5) ** 1.5 * (0.4 + y * 0.6),
  };

  const COLORS = { band: WHITE, oss: [107, 143, 227] };

  // Small seeded random so the pattern looks the same on every visit.
  function seeded(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function drawMosaic(holder) {
    const canvas = holder.querySelector('canvas');
    const layout = LAYOUTS[holder.dataset.mosaic];
    if (!canvas || !layout) return;

    const rect = holder.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const [r, g, b] = COLORS[holder.dataset.mosaic] || BRAND;
    const random = seeded(holder.dataset.mosaic.length * 7919 + 17);
    const step = CELL + GAP;
    const cols = Math.ceil(rect.width / step);
    const rows = Math.ceil(rect.height / step);

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const weight = Math.min(1, layout(col / cols, row / rows));
        const roll = random();
        if (weight <= 0.02 || roll > weight * 0.9 + 0.06) continue;
        const alpha = 0.05 + weight * random() * 0.75;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
        ctx.fillRect(col * step, row * step, CELL, CELL);
      }
    }
  }

  const mosaics = Array.from(document.querySelectorAll('[data-mosaic]'));
  function drawAll() {
    mosaics.forEach((holder) => {
      if (holder.offsetParent !== null) drawMosaic(holder);
    });
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawAll, 150);
  });

  // Tab groups: each tab points at its panel with aria-controls.
  function setupTabs(list) {
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));

    function select(tab, focus) {
      tabs.forEach((other) => {
        const on = other === tab;
        other.setAttribute('aria-selected', String(on));
        other.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(other.getAttribute('aria-controls'));
        if (!panel) return;
        panel.hidden = !on;
        panel.classList.toggle('on', on);
      });
      if (focus) tab.focus();
      drawAll();
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => select(tab, false));
      tab.addEventListener('keydown', (event) => {
        const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
        if (!(event.key in keys)) return;
        event.preventDefault();
        const next = tabs[(index + keys[event.key] + tabs.length) % tabs.length];
        select(next, true);
      });
    });
  }

  document.querySelectorAll('[role="tablist"]').forEach(setupTabs);

  // Phone menu.
  const nav = document.getElementById('nav');
  const toggle = document.getElementById('menu-toggle');
  if (nav && toggle) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });
    nav.querySelectorAll('ul a, .actions a').forEach((link) => {
      link.addEventListener('click', () => {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Open menu');
      });
    });
  }


  // Pricing period switch: buttons with data-period set the prices in [data-monthly][data-yearly].
  document.querySelectorAll('[data-period-switch]').forEach((group) => {
    const buttons = Array.from(group.querySelectorAll('button[data-period]'));
    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        const period = button.dataset.period;
        buttons.forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
        document.querySelectorAll('[data-monthly][data-yearly]').forEach((price) => {
          price.textContent = price.dataset[period];
        });
        document.querySelectorAll('[data-period-note]').forEach((note) => {
          note.hidden = note.dataset.periodNote !== period;
        });
      });
    });
  });

  // Integrations filter: buttons with data-filter show the cards whose data-cat matches.
  document.querySelectorAll('[data-filter-group]').forEach((group) => {
    const buttons = Array.from(group.querySelectorAll('button[data-filter]'));
    const cards = Array.from(document.querySelectorAll(group.dataset.filterGroup));
    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        const filter = button.dataset.filter;
        buttons.forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
        cards.forEach((card) => {
          card.hidden = filter !== 'all' && card.dataset.cat !== filter;
        });
      });
    });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', drawAll);
  } else {
    drawAll();
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawAll);
})();
