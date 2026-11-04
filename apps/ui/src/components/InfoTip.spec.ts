import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import InfoTip from './InfoTip.vue';

const Host = defineComponent({
  setup: () => () =>
    h('div', [
      h(InfoTip, { label: 'About max steps' }, () => [h('p', 'One step is one model call.'), h('a', { href: '#/harnesses', id: 'inside' }, 'More')]),
      h('button', { id: 'after', type: 'button' }, 'Next field'),
    ]),
});

let wrapper: ReturnType<typeof mount> | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

const parts = () => {
  wrapper = mount(Host, { attachTo: document.body });
  const button = wrapper.get('[data-test="info-button"]');
  const note = wrapper.get('[data-test="info-note"]');
  return { w: wrapper, button, note, shown: () => (note.element as HTMLElement).style.display !== 'none' };
};

describe('InfoTip', () => {
  it('is a real button, named by its label, that says whether its note is open', async () => {
    const { button, note, shown } = parts();
    expect(button.element.tagName).toBe('BUTTON');
    expect(button.attributes('type')).toBe('button');
    expect(button.attributes('aria-label')).toBe('About max steps');
    expect(button.attributes('aria-controls')).toBe(note.attributes('id'));
    expect(shown()).toBe(false);
    await button.trigger('click');
    expect(button.attributes('aria-expanded')).toBe('true');
    expect(shown()).toBe(true);
    expect(note.text()).toContain('One step is one model call.');
    await button.trigger('click');
    expect(button.attributes('aria-expanded')).toBe('false');
    expect(shown()).toBe(false);
  });

  it('closes on Escape from inside the note and gives focus back to the button', async () => {
    const { w, button, shown } = parts();
    await button.trigger('click');
    const inside = w.get('#inside').element as HTMLElement;
    inside.focus();
    inside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await w.vm.$nextTick();
    expect(shown()).toBe(false);
    expect(document.activeElement).toBe(button.element);
  });

  it('closes when focus tabs past it, and stays open while focus moves inside it', async () => {
    const { w, button, shown } = parts();
    await button.trigger('click');
    await button.trigger('focusout', { relatedTarget: w.get('#inside').element });
    expect(shown()).toBe(true);
    await button.trigger('focusout', { relatedTarget: w.get('#after').element });
    expect(shown()).toBe(false);
  });

  it('ignores Escape while closed', async () => {
    const { w, button, shown } = parts();
    (w.get('#after').element as HTMLElement).focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await w.vm.$nextTick();
    expect(shown()).toBe(false);
    expect(document.activeElement).not.toBe(button.element);
  });
});
