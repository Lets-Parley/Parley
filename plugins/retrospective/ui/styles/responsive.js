export const RESPONSIVE_STYLES = [
  "@media (pointer:coarse){.btn,.menu-item{min-height:44px}.pick,.grip,.more{width:44px;height:44px}.stage-3 .target{min-width:44px;height:44px}.board:not(.stage-3) .target{min-height:32px;height:32px}.sort{height:36px}.strip button{width:44px;height:44px}.trail{min-height:44px}.chips{padding-bottom:20px}.note-text{padding:12px 0}" +
    // What is drawn smaller than a fingertip is still pressed over 44px.
    '.target{position:relative;justify-content:center;min-width:44px}.board:not(.stage-3) .target::after{content:"";position:absolute;inset:-7px -1px}.st::after{content:"";position:absolute;inset:-1px}' +
    // The three buttons on a note's lower edge: 32 across, 44 apart, each pressed
    // over 44, and far enough in that none of that is over the menu button.
    '.rx{gap:12px;bottom:-16px;right:60px}.rb{width:32px;height:32px;opacity:1}.rb::after{content:"";position:absolute;inset:-7px}.brk{opacity:1}.oops{top:calc(100% + 26px)}}',

  // A phone. The header is two short rows and a hint: the steps shrink to
  // their numbers around the current one, the hint is one line that opens,
  // and authorship is a sentence and a button. Everything that floats is a
  // sheet along the bottom edge, never taller than the screen.
  "@media (max-width:600px){",
  ".top{gap:10px}",
  ".progress{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:8px 12px}",
  ".steps-wrap{flex:1 1 auto}",
  ".steps{flex-wrap:nowrap;gap:2px}",
  ".step{min-height:28px;padding:0 6px}",
  ".step.current{padding:0 10px 0 6px}",
  ".step:not(.current) .step-name{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}",
  ".timer-slot{display:contents}",
  ".timer-face{min-height:28px;font-size:13px}",
  ".timer-paused{display:none}",
  ".timer-open{order:4}",
  ".timer-open>span{display:none}",
  ".hints{order:2;flex:1 1 100%;min-width:0;display:flex;align-items:flex-start;gap:4px;margin:0 2px;cursor:pointer}",
  ".hint{display:none;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".hint.shown{display:block}",
  ".hints.open .hint{white-space:normal}",
  ".hint-more{flex:none;display:grid;place-items:center;width:24px;height:24px;margin-top:-2px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--color-ink-soft);transition:rotate .15s}",
  ".hints.open .hint-more{rotate:180deg}",
  ".stage-nav{order:3;flex:1 1 auto;justify-content:flex-start}",
  ".back-to{display:none}",
  ".authorship{padding:8px 12px 8px 16px;gap:6px 12px}",
  ".auth-text{flex:1 1 6rem}",
  ".auth-title{font-size:14px}",
  ".authorship:not(.armed) .fine{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}",
  "}",
  "@media (max-width:600px) and (pointer:coarse){.top .btn{min-height:36px}}",
  "@media (max-width:480px){",
  ".pop{position:fixed;left:8px!important;right:8px;top:auto!important;bottom:8px;width:auto;max-width:none;max-height:min(70vh,480px);border-radius:20px}",
  ".sheet{width:auto}",
  ".link-list{max-height:none}",
  // The sticker book is a sheet along the bottom edge, over a scrim.
  ".book-pop{left:0!important;right:0;bottom:0;max-height:none;padding:8px 12px calc(14px + env(safe-area-inset-bottom,0px));border-width:1px 0 0;border-radius:20px 20px 0 0}",
  '.book-pop::before{content:"";flex:none;width:36px;height:4px;margin:0 auto;border-radius:2px;background:var(--color-line-strong)}',
  ".choice{height:52px}",
  ".scrim{display:block;position:fixed;inset:0;background:rgb(var(--sh)/.35)}",
  // A menu is a sheet along the bottom edge too, with rows a thumb can
  // press, no shortcuts, and a way out in sight.
  ".pop.menu{left:0!important;right:0;bottom:0;max-height:76vh;padding:8px 10px calc(14px + env(safe-area-inset-bottom,0px));border-width:1px 0 0;border-radius:20px 20px 0 0}",
  '.pop.menu::before{content:"";flex:none;align-self:center;width:36px;height:4px;margin:0 0 6px;border-radius:2px;background:var(--color-line-strong)}',
  ".menu-item{min-height:48px;font-size:15px}",
  ".menu-title,.off-why{max-width:none}",
  ".strip{min-height:52px}.strip button{width:46px;height:44px}",
  ".menu .keys{display:none}",
  ".st-sheet{width:auto}.st-list{max-height:none}.st-list li{min-height:48px}.st-do{width:44px;height:44px}",
  ".menu-done{display:flex;justify-content:center;margin-top:6px;border:1px solid var(--color-line-strong);font-weight:700}",
  ".book-done{display:block;align-self:flex-end;min-width:88px;min-height:44px}",
  "}",
  "@media (max-width:340px){.book-pop{padding-inline:4px}.book{padding:6px 2px}}",

  // The host's own keyframes for a note being set down: a short fall under
  // gravity, then a slide that friction brings to a dead stop.
  "@keyframes note-set-down{",
  "0%{transform:translate(-14px,-10px) rotate(-3.2deg) scale(1.035);box-shadow:var(--shadow-lift);opacity:0}",
  "6.3%{transform:translate(-12.72px,-9.72px) rotate(-2.91deg) scale(1.034);opacity:1}",
  "12.6%{transform:translate(-11.43px,-8.89px) rotate(-2.61deg) scale(1.0311)}",
  "19%{transform:translate(-10.15px,-7.5px) rotate(-2.32deg) scale(1.0263)}",
  "25.3%{transform:translate(-8.87px,-5.56px) rotate(-2.03deg) scale(1.0194)}",
  "31.6%{transform:translate(-7.58px,-3.06px) rotate(-1.73deg) scale(1.0107)}",
  "37.9%{transform:translate(-6.3px,0) rotate(-1.44deg) scale(1);box-shadow:var(--shadow-rest)}",
  "45.7%{transform:translate(-4.82px,0) rotate(-1.1deg)}",
  "53.4%{transform:translate(-3.54px,0) rotate(-.81deg)}",
  "61.2%{transform:translate(-2.46px,0) rotate(-.56deg)}",
  "69%{transform:translate(-1.57px,0) rotate(-.36deg)}",
  "76.7%{transform:translate(-.89px,0) rotate(-.2deg)}",
  "84.5%{transform:translate(-.39px,0) rotate(-.09deg)}",
  "92.2%{transform:translate(-.1px,0) rotate(-.02deg)}",
  "100%{transform:translate(0,0) rotate(0)}}",
  ".arriving{animation:note-set-down 790ms linear both}",
  "@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}",
];

