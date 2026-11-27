// Product pages: scroll reveal, captions that change with the steps, line drawing dots, and the FAQ.
(() => {
  const reveal = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('in');
      reveal.unobserve(entry.target);
    });
  }, { threshold: 0.15 });
  document.querySelectorAll('.rv').forEach((el) => reveal.observe(el));

  // Steps beside a photo: each step shows its caption, and they play in turn.
  document.querySelectorAll('[data-steps]').forEach((box) => {
    const steps = Array.from(box.querySelectorAll('.step'));
    const cap = document.getElementById(box.dataset.steps);
    if (!steps.length || !cap) return;
    let index = 0;
    let timer;
    const show = (next) => {
      steps.forEach((step) => step.classList.remove('on'));
      void steps[0].offsetWidth;
      index = next % steps.length;
      const step = steps[index];
      step.classList.add('on');
      const drawing = cap.parentElement.querySelector('.art');
      if (drawing) drawing.dataset.on = String(index);
      cap.classList.add('out');
      setTimeout(() => {
        const magpie = step.dataset.who === 'magpie';
        cap.innerHTML = `<span class="tag ${magpie ? 'mp' : ''}"></span><p></p>`;
        cap.querySelector('.tag').textContent = step.dataset.tag || (magpie ? 'Magpie' : 'customer');
        cap.querySelector('p').textContent = step.dataset.say;
        cap.classList.remove('out');
      }, 380);
      clearTimeout(timer);
      timer = setTimeout(() => show(index + 1), 5000);
    };
    steps.forEach((step, n) => step.addEventListener('click', () => show(n)));
    show(0);
  });

  // Line drawings: once one is on screen and drawn, start the dots that run along its lines.
  const startDots = (drawing) => {
    drawing.querySelectorAll('.dot').forEach((dot) => {
      const delay = 1400 + Number(dot.dataset.delay || 0);
      setTimeout(() => {
        dot.querySelectorAll('animate, animateMotion').forEach((animation) => animation.beginElement());
      }, delay);
    });
  };
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const onScreen = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        startDots(entry.target);
        onScreen.unobserve(entry.target);
      });
    }, { threshold: 0.3 });
    document.querySelectorAll('.art').forEach((drawing) => onScreen.observe(drawing));
  }

  document.querySelectorAll('.q button').forEach((button) => {
    button.addEventListener('click', () => {
      const open = button.parentElement.classList.toggle('open');
      button.setAttribute('aria-expanded', String(open));
    });
  });
})();
