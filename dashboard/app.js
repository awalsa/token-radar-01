// Token Radar's dashboard, rendered on a dark radar screen. It reads window.RADAR — the
// dataset main.ts writes beside dashboard/ — and paints the ranked board, a filterable table,
// a per-protocol detail view carrying the model's own inputs and the protocol's farm plan, and
// the category multiples the model learned. No network: every byte on the page comes from data.js.
(function () {
  'use strict';

  var data = window.RADAR;
  if (!data) return;
  var app = document.getElementById('board');
  var view = { q: '', category: 'all', watchlist: false, tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  // Build one element: attrs maps names to values ('class' sets the class, 'text' sets the
  // text, 'html' sets the markup, 'on*' registers a listener, anything else becomes an
  // attribute), then children are appended — arrays flattened one level, strings as text.
  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var value = attrs[k];
        if (k === 'class') node.setAttribute('class', value);
        else if (k === 'text') node.textContent = value;
        else if (k === 'html') node.innerHTML = value;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), value);
        else if (value !== null && value !== undefined) node.setAttribute(k, value);
      });
    }
    var kids = Array.prototype.slice.call(arguments, 2);
    kids.forEach(function (child) {
      if (child === null || child === undefined) return;
      if (Array.isArray(child)) {
        child.forEach(function (c) { if (c) node.appendChild(c); });
      } else if (typeof child === 'string') {
        node.appendChild(document.createTextNode(child));
      } else {
        node.appendChild(child);
      }
    });
    return node;
  }

  var usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFormat.format(n);
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function ageText(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function multText(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n.toFixed(3) + 'x';
  }
  // Four decimals for the model's multipliers: the stored values are full precision (the page
  // recomputes from them), but a reader wants 0.8488, not 0.8487671232876712.
  function mult4dp(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n.toFixed(4);
  }
  // The model in one function: the page recomputes a row from the snapshot figures and checks
  // it against the number board.json carries, so the page's arithmetic and the board's data
  // visibly agree. The category multiple is the snapshot's own live market, learned per category.
  function recomputeImplied(row) {
    return Math.max(1, Math.round(row.tvl_usd * row.category_multiple * row.growth_multiplier * row.maturity_multiplier));
  }

  function readStateFromHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) view.q = params.get('q');
    if (params.get('p')) view.selected = params.get('p');
    if (params.get('category')) view.category = params.get('category');
    if (params.get('watchlist') === '1') view.watchlist = true;
    if (params.get('sort')) view.sort = params.get('sort');
    if (params.get('tab')) view.tab = params.get('tab');
  }
  function writeStateToHash() {
    var params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.watchlist) params.set('watchlist', '1');
    if (view.sort !== 'implied') params.set('sort', view.sort);
    if (view.tab !== 'pre-token') params.set('tab', view.tab);
    if (view.selected) params.set('p', view.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function visibleRows() {
    var q = view.q.trim().toLowerCase();
    return data.rows.filter(function (r) {
      if (view.watchlist && !r.watchlist) return false;
      if (view.category !== 'all' && r.category !== view.category) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function orderedRows(list) {
    var key = view.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? -Infinity : a.age_days; bv = b.age_days === null ? -Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -view.dir;
      if (av > bv) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // The radar mark is inline SVG markup, parsed by the HTML parser into real SVG elements:
  // no namespace URI string anywhere in the source, so the page names no network address.
  function radarMark() {
    return h('span', { class: 'sweep', html: '<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><g fill="none" stroke="#43587a" stroke-width="1"><circle cx="17" cy="17" r="15"/><circle cx="17" cy="17" r="10"/><circle cx="17" cy="17" r="5"/><line x1="17" y1="2" x2="17" y2="32"/><line x1="2" y1="17" x2="32" y2="17"/></g><line x1="17" y1="17" x2="28" y2="6" stroke="#34d399" stroke-width="2"/><circle cx="28" cy="6" r="2.5" fill="#34d399"/><circle cx="17" cy="17" r="2" fill="#22d3ee"/></svg>' });
  }

  function pageHeader() {
    return h('header', { class: 'top' },
      h('div', { class: 'brand' }, radarMark(), h('span', { class: 'brand-name', html: 'Token <em>Radar</em>' })),
      h('div', { class: 'top-meta' },
        h('span', { text: 'Snapshot ' + data.as_of }),
        h('span', { text: 'DefiLlama protocol index' }),
        h('span', { text: data.model_version + ' model' })
      )
    );
  }

  function intro() {
    var top = data.rows[0];
    var mid = data.rows[Math.floor(data.rows.length / 2)];
    return h('section', { class: 'lede' },
      h('div', null,
        h('h1', { text: data.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        h('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(data.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + data.early_size + ' pre-token protocols below that floor, each scored by what the snapshot itself says a token would be worth. Implied value is a model, not a promise.' })
      ),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('span', { text: 'Top implied value' }), h('b', { class: 'hot', text: top ? money(top.implied_value_usd) : 'n/a' })),
        h('div', { class: 'stat' }, h('span', { text: 'Median implied value' }), h('b', { text: mid ? money(mid.implied_value_usd) : 'n/a' })),
        h('div', { class: 'stat' }, h('span', { text: 'Watchlist covered' }), h('b', { text: data.watchlist_size + ' / ' + data.watchlist_size })),
        h('div', { class: 'stat' }, h('span', { text: 'Live-token protocols set aside' }), h('b', { text: String(data.live_size) }))
      )
    );
  }

  function topSignals() {
    var top10 = data.rows.slice(0, 10);
    if (top10.length === 0) return null;
    var max = top10[0].implied_value_usd || 1;
    return h('section', { class: 'spotlight' },
      h('h2', { text: 'Strongest signals' }),
      h('div', { class: 'spot' }, top10.map(function (r) {
        return h('div', { class: 'spot-row' },
          h('span', { class: 'rk', text: '#' + r.rank }),
          h('span', { class: 'nm', text: r.name }),
          h('span', { class: 'tr' }, h('i', { style: 'width:' + Math.max(4, Math.round(Math.sqrt(r.implied_value_usd / max) * 100)) + '%' })),
          h('span', { class: 'vl', text: money(r.implied_value_usd) })
        );
      }))
    );
  }

  function boardControls() {
    var categories = Array.from(new Set(data.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = h('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { view.q = search.value; writeStateToHash(); paint(); });
    var select = h('select', { id: 'category', 'aria-label': 'Filter by category' },
      h('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return h('option', { value: c, text: c, selected: c === view.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { view.category = select.value; writeStateToHash(); paint(); });
    var watch = h('input', { type: 'checkbox', id: 'watchlist', checked: view.watchlist ? 'checked' : null, 'aria-label': 'Watchlist only' });
    watch.addEventListener('change', function () { view.watchlist = watch.checked; writeStateToHash(); paint(); });
    var sort = h('select', { id: 'sort', 'aria-label': 'Sort the board' },
      h('option', { value: 'implied', text: 'Implied value', selected: view.sort === 'implied' ? 'selected' : null }),
      h('option', { value: 'tvl', text: 'TVL', selected: view.sort === 'tvl' ? 'selected' : null }),
      h('option', { value: 'growth', text: '7-day growth', selected: view.sort === 'growth' ? 'selected' : null }),
      h('option', { value: 'age', text: 'Age', selected: view.sort === 'age' ? 'selected' : null }),
      h('option', { value: 'name', text: 'Name', selected: view.sort === 'name' ? 'selected' : null })
    );
    sort.addEventListener('change', function () { view.sort = sort.value; view.dir = sort.value === 'name' ? 1 : -1; writeStateToHash(); paint(); });
    var dir = h('button', { type: 'button', class: 'button', 'aria-label': 'Reverse sort order', text: view.dir < 0 ? 'Highest first' : 'Lowest first', onclick: function () { view.dir = -view.dir; writeStateToHash(); paint(); } });
    var pre = h('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { view.tab = 'pre-token'; paint(); } });
    var live = h('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { view.tab = 'live'; paint(); } });
    return h('div', { class: 'controls' },
      h('div', { class: 'field' }, h('label', { for: 'q', text: 'Search' }), search),
      h('div', { class: 'field' }, h('label', { for: 'category', text: 'Category' }), select),
      h('label', { class: 'check', for: 'watchlist' }, watch, 'Watchlist only'),
      h('div', { class: 'field' }, h('label', { for: 'sort', text: 'Sort by' }), sort),
      dir,
      h('div', { class: 'field' }, h('span', { class: 'sub', text: 'Token status' }), h('div', { class: 'tabs' }, pre, live)),
      h('span', { class: 'count', text: view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : data.live.length + ' live-token protocols' })
    );
  }

  function preTokenTable() {
    var list = orderedRows(visibleRows());
    if (list.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category to see the board again.' }),
        h('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { view.q = ''; view.category = 'all'; view.watchlist = false; writeStateToHash(); paint(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = h('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = h('tr', {
        'data-selected': view.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { showDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail(r.slug); } }
      },
        h('td', { class: 'num', text: String(r.rank) }),
        h('td', null, h('div', { class: 'name' },
          h('div', { class: 'rowline' }, h('b', { text: r.name }), r.watchlist ? h('span', { class: 'badge', text: 'Watchlist' }) : null),
          h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + growthClass, text: growth }),
        h('td', { class: 'num', text: ageText(r.age_days) }),
        h('td', { class: 'num', text: multText(r.category_multiple) }),
        h('td', null, h('div', { class: 'implied' },
          h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          h('span', { class: 'num', text: money(r.implied_value_usd) })
        )),
        h('td', null, h('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', text: 'Rank' }),
            h('th', { scope: 'col', text: 'Protocol' }),
            h('th', { scope: 'col', text: 'TVL' }),
            h('th', { scope: 'col', text: '7d' }),
            h('th', { scope: 'col', text: 'Age' }),
            h('th', { scope: 'col', text: 'Category x' }),
            h('th', { scope: 'col', text: 'Implied value' }),
            h('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTokenTable() {
    var tbody = h('tbody');
    data.live.forEach(function (r) {
      var ratio = r.tvl_usd > 0 && r.mcap_usd !== null ? r.mcap_usd / r.tvl_usd : null;
      tbody.appendChild(h('tr', null,
        h('td', null, h('span', { class: 'status live', text: 'live' })),
        h('td', null, h('div', { class: 'name' }, h('b', { text: r.name }), h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        h('td', { class: 'num', text: money(r.mcap_usd) }),
        h('td', { class: 'num', text: multText(ratio) }),
        h('td', null, h('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking, and their market-cap / TVL is the ratio the model learns from.' }),
          h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col', text: 'Protocol' }), h('th', { scope: 'col', text: 'TVL' }), h('th', { scope: 'col', text: '7d' }), h('th', { scope: 'col', text: 'Market cap' }), h('th', { scope: 'col', text: 'Mcap / TVL' }), h('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelExplainer() {
    var m = data.model;
    var mults = (data.category_multiples || []).slice(0, 12);
    return h('section', { class: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      h('div', { class: 'formula' },
        'implied = round( tvl_usd x category_multiple x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') )'
      ),
      h('div', { class: 'model-grid' },
        h('div', null,
          h('h3', { text: 'What the snapshot teaches' }),
          h('p', { class: 'sub', text: 'The category multiple is the median market-cap / TVL of the live-token protocols in that category, shrunk toward the snapshot-wide median of ' + multText(data.global_multiple) + ' with a prior weight of ' + m.shrink_prior + ', then clamped to ' + m.multiple_floor + 'x..' + m.multiple_cap + 'x. A category with no live protocol to learn from takes the snapshot-wide median. Age is the time since the protocol was first listed; an unlisted age uses the median pre-token age of ' + m.unknown_age_days + ' days.' })
        ),
        h('div', null,
          h('h3', { text: 'Strongest category multiples' }),
          h('table', { class: 'mult-table' },
            h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Category' }), h('th', { scope: 'col', class: 'num', text: 'Multiple' }), h('th', { scope: 'col', class: 'num', text: 'Live comps' }))),
            h('tbody', null, mults.map(function (c) {
              return h('tr', null, h('td', { text: c.category }), h('td', { class: 'num', text: multText(c.multiple) }), h('td', { class: 'num', text: String(c.comps) }));
            }))
          )
        )
      )
    );
  }

  var dialog = h('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { view.selected = null; writeStateToHash(); });

  function showDetail(slug) {
    var row = data.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    view.selected = slug;
    writeStateToHash();
    dialog.textContent = '';
    var recomputed = recomputeImplied(row);
    dialog.appendChild(h('div', { class: 'detail-head' },
      h('div', null,
        h('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + data.board_size + (row.watchlist ? '  ·  Watchlist' : '') }),
        h('h2', { id: 'detail-title', text: row.name }),
        h('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' },
        h('div', null, h('span', { text: 'TVL' }), h('b', { class: 'num', text: money(row.tvl_usd) })),
        h('div', null, h('span', { text: 'Category multiple' }), h('b', { class: 'num', text: multText(row.category_multiple) })),
        h('div', null, h('span', { text: 'Seven-day growth' }), h('b', { class: 'num', text: pct(row.change_7d) })),
        h('div', null, h('span', { text: 'Growth multiplier' }), h('b', { class: 'num', text: mult4dp(row.growth_multiplier) })),
        h('div', null, h('span', { text: 'Age with no token' }), h('b', { class: 'num', text: ageText(row.age_days) })),
        h('div', null, h('span', { text: 'Maturity multiplier' }), h('b', { class: 'num', text: mult4dp(row.maturity_multiplier) })),
        h('div', { class: 'total' }, h('span', { text: 'Implied value' }), h('b', { class: 'num', text: money(row.implied_value_usd) }))
      ),
      h('p', { class: 'sub', text: 'Model ' + data.model_version + ': the same function scores every protocol. The page recomputes this row as ' + money(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, (row.farm_steps || []).map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, h('b', { text: action }), h('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function pageFooter() {
    return h('footer', { class: 'foot' },
      h('span', { text: 'Source: ' + data.source + ', snapshot ' + data.as_of + '. Model ' + data.model_version + '.' }),
      h('span', { text: 'Implied value is a model, not a price. No token exists for the protocols on this board.' })
    );
  }

  function paint() {
    app.textContent = '';
    var shell = h('div', { class: 'shell' });
    shell.appendChild(pageHeader());
    shell.appendChild(intro());
    if (view.tab === 'pre-token') shell.appendChild(topSignals());
    shell.appendChild(boardControls());
    shell.appendChild(view.tab === 'pre-token' ? preTokenTable() : liveTokenTable());
    if (view.tab === 'pre-token') shell.appendChild(modelExplainer());
    shell.appendChild(pageFooter());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (view.selected) showDetail(view.selected);
  }

  readStateFromHash();
  paint();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
