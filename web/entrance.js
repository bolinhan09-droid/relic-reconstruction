(() => {
  'use strict';
  const landing = document.getElementById('landingScreen');
  const studio = document.getElementById('studioShell');
  const enter = document.getElementById('enterStudio');
  const home = document.getElementById('homeButton');
  if (!landing || !studio || !enter) return;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  let studioOpen = false;
  let motionFrame = 0;
  let pointerX = 0;
  let pointerY = 0;
  let motionPaused = false;
  const motionButton = document.createElement('button');
  motionButton.type = 'button';
  motionButton.id = 'motionToggle';
  motionButton.className = 'motion-toggle';
  motionButton.textContent = '暂停动态';
  motionButton.setAttribute('aria-pressed', 'false');
  motionButton.hidden = reduceMotion.matches;
  const landingHeader = landing.querySelector('.landing-header');
  if (landingHeader) {
    const controls = document.createElement('div');
    controls.className = 'landing-controls';
    const localLabel = landingHeader.querySelector('.landing-local');
    if (localLabel) controls.append(localLabel);
    controls.append(motionButton);
    landingHeader.append(controls);
  }
  motionButton.addEventListener('click', () => {
    motionPaused = !motionPaused;
    landing.classList.toggle('motion-paused', motionPaused);
    motionButton.setAttribute('aria-pressed', String(motionPaused));
    motionButton.textContent = motionPaused ? '恢复动态' : '暂停动态';
    if (motionPaused) {
      pointerX = pointerY = 0;
      updateAtmosphere();
    }
  });

  function showStudio(open, focus = false) {
    studioOpen = open;
    landing.hidden = open;
    studio.hidden = !open;
    document.body.classList.toggle('landing-active', !open);
    document.body.classList.toggle('studio-active', open);
    window.scrollTo({ top: 0, behavior: 'instant' });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (open) window.dispatchEvent(new CustomEvent('studio:entered'));
      if (focus) {
        const target = open ? document.getElementById('studioTitle') : enter;
        target?.focus({ preventScroll: true });
      }
    }));
  }
  enter.addEventListener('click', () => {
    if (window.location.hash !== '#studio') window.location.hash = 'studio';
    showStudio(true, true);
  });
  home?.addEventListener('click', (event) => {
    event.preventDefault();
    window.history.pushState(null, '', window.location.pathname + window.location.search);
    showStudio(false, true);
  });
  window.addEventListener('hashchange', () => showStudio(window.location.hash === '#studio', true));
  window.addEventListener('popstate', () => showStudio(window.location.hash === '#studio'));
  showStudio(window.location.hash === '#studio');

  function updateAtmosphere() {
    motionFrame = 0;
    landing.style.setProperty('--pointer-x', `${pointerX.toFixed(2)}px`);
    landing.style.setProperty('--pointer-y', `${pointerY.toFixed(2)}px`);
  }
  landing.addEventListener('pointermove', (event) => {
    if (studioOpen || motionPaused || reduceMotion.matches || !finePointer.matches) return;
    pointerX = (event.clientX / window.innerWidth - .5) * 18;
    pointerY = (event.clientY / window.innerHeight - .5) * 12;
    if (!motionFrame) motionFrame = requestAnimationFrame(updateAtmosphere);
  }, { passive: true });
  landing.addEventListener('pointerleave', () => {
    pointerX = pointerY = 0;
    if (!motionFrame) motionFrame = requestAnimationFrame(updateAtmosphere);
  });
  reduceMotion.addEventListener?.('change', () => {
    motionButton.hidden = reduceMotion.matches;
    if (reduceMotion.matches) {
      pointerX = pointerY = 0;
      updateAtmosphere();
    }
  });
})();
