import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Plus } from 'lucide-react';
import { Button } from './Button';
import { Card, CardAction } from './Card';
import { ConfirmDialog } from './ConfirmDialog';
import { Drawer } from './Drawer';
import { IconButton } from './IconButton';
import { Modal } from './Modal';
import { SegmentedControl } from './SegmentedControl';
import { Menu } from './Menu';
import { Tooltip } from './Tooltip';
import { rovingIndex } from './roving';
import { focusableWithin } from './focus';
import { nth } from '../../test/assert';

const ModalHarness: React.FC = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Dialog title">
        <input aria-label="first" />
        <button type="button">last</button>
      </Modal>
    </>
  );
};

describe('Modal', () => {
  it('is a labelled modal dialog, focuses the first control and closes on Escape', () => {
    render(<ModalHarness />);
    const trigger = screen.getByText('open');
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Dialog title' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.closest('[data-modal-overlay]')).not.toBeNull();
    expect(screen.getByLabelText('first')).toHaveFocus();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('traps Tab inside the dialog', () => {
    render(<ModalHarness />);
    fireEvent.click(screen.getByText('open'));
    const last = screen.getByText('last');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
  });
});

describe('Drawer', () => {
  it('traps Tab inside the panel', () => {
    render(
      <Drawer open onClose={() => undefined} label="Details">
        <button type="button">first</button>
        <button type="button">last</button>
      </Drawer>,
    );
    const panel = screen.getByRole('complementary', { name: 'Details' });
    expect(panel).toHaveAttribute('aria-modal', 'true');
    const last = screen.getByText('last');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('first'));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(panel.contains(document.activeElement)).toBe(true);
  });
});

const TooltipInModalHarness: React.FC = () => {
  const [open, setOpen] = useState(true);
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Dialog title">
      <Tooltip content="Helpful hint">
        <button type="button">act</button>
      </Tooltip>
    </Modal>
  );
};

describe('Tooltip', () => {
  it('swallows the Escape that closes it, leaving the dialog underneath open', () => {
    vi.useFakeTimers();
    try {
      render(<TooltipInModalHarness />);
      const trigger = screen.getByText('act');
      fireEvent.focus(trigger);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByRole('tooltip')).toHaveTextContent('Helpful hint');

      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Dialog title' })).toBeInTheDocument();

      // The next Escape reaches the dialog, because no tooltip is listening any more.
      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ConfirmDialog', () => {
  it('focuses Cancel first and reports the choice', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        message="Gone forever"
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('alertdialog', { name: 'Delete?' })).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toHaveFocus();
    fireEvent.click(screen.getByText('Delete'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe('SegmentedControl', () => {
  it('is a radiogroup with roving tabindex and arrow-key selection', () => {
    const Harness = () => {
      const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
      return (
        <SegmentedControl
          label="View"
          value={value}
          onChange={setValue}
          options={[
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
            { value: 'c', label: 'Gamma' },
          ]}
        />
      );
    };
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'View' });
    const radios = screen.getAllByRole('radio');
    expect(group).toBeInTheDocument();
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(nth(radios, 0), { key: 'ArrowRight' });
    expect(nth(screen.getAllByRole('radio'), 1)).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(nth(screen.getAllByRole('radio'), 1), { key: 'End' });
    expect(nth(screen.getAllByRole('radio'), 2)).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Modal overlay', () => {
  it('closes only for a press that starts and ends on the overlay', () => {
    render(<ModalHarness />);
    fireEvent.click(screen.getByText('open'));
    const dialog = screen.getByRole('dialog', { name: 'Dialog title' });
    const overlay = dialog.closest('[data-modal-overlay]')?.firstElementChild as HTMLElement;

    fireEvent.pointerDown(screen.getByLabelText('first'));
    fireEvent.pointerUp(overlay);
    fireEvent.click(overlay);
    expect(screen.getByRole('dialog', { name: 'Dialog title' })).toBeInTheDocument();

    fireEvent.pointerDown(overlay);
    fireEvent.pointerUp(overlay);
    fireEvent.click(overlay);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('IconButton', () => {
  it('always has an accessible name', () => {
    render(<IconButton label="Add bookmark" icon={Plus} />);
    expect(screen.getByRole('button', { name: 'Add bookmark' })).toBeInTheDocument();
  });
});

describe('Button loading', () => {
  it('keeps focus and ignores clicks while loading instead of going natively disabled', () => {
    const onClick = vi.fn();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const { rerender } = render(
      <form onSubmit={onSubmit}>
        <Button type="submit" onClick={onClick}>
          Save
        </Button>
        <IconButton label="Refresh" icon={Plus} onClick={onClick} />
      </form>,
    );
    const save = screen.getByRole('button', { name: 'Save' });
    save.focus();

    rerender(
      <form onSubmit={onSubmit}>
        <Button type="submit" onClick={onClick} loading>
          Save
        </Button>
        <IconButton label="Refresh" icon={Plus} onClick={onClick} loading />
      </form>,
    );
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    expect(save).toHaveFocus();
    for (const button of [save, refresh]) {
      expect(button).toBeEnabled();
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).toHaveAttribute('aria-busy', 'true');
      fireEvent.click(button);
    }
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('stays natively disabled when disabled on purpose', () => {
    render(
      <Button disabled loading>
        Save
      </Button>,
    );
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(save).not.toHaveAttribute('aria-disabled');
  });
});

describe('Menu', () => {
  it('opens with ArrowDown, exposes menuitems and closes with Escape', () => {
    const onSelect = vi.fn();
    render(
      <Menu
        label="More"
        items={[
          { id: 'a', label: 'First', onSelect },
          { id: 'b', label: 'Disabled', onSelect, disabled: true, description: 'Why not' },
        ]}
        trigger={(props) => (
          <button type="button" {...props}>
            more
          </button>
        )}
      />,
    );
    const trigger = screen.getByText('more');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('menu', { name: 'More' })).toBeInTheDocument();
    const items = screen.getAllByRole('menuitem');
    expect(items[1]).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(nth(items, 1));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Menu Tab handling', () => {
  it('closes on Tab and hands focus back to the trigger instead of the document', () => {
    render(
      <Menu
        label="More"
        items={[{ id: 'a', label: 'First', onSelect: vi.fn() }]}
        trigger={(props) => (
          <button type="button" {...props}>
            more
          </button>
        )}
      />,
    );
    const trigger = screen.getByText('more');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const item = screen.getByRole('menuitem');
    expect(item).toHaveFocus();
    const notPrevented = fireEvent.keyDown(item, { key: 'Tab' });
    expect(notPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe('focusableWithin', () => {
  it('skips controls inside hidden or inert subtrees', () => {
    const { container } = render(
      <div>
        <button type="button">visible</button>
        <div hidden>
          <button type="button">hidden</button>
        </div>
        <div inert>
          <button type="button">inert</button>
        </div>
      </div>,
    );
    expect(focusableWithin(container).map((el) => el.textContent)).toEqual(['visible']);
  });
});

describe('CardAction', () => {
  it('draws its focus ring inside the card so overflow-hidden cannot clip it', () => {
    render(
      <Card as="article" className="overflow-hidden">
        <CardAction>Open</CardAction>
      </Card>,
    );
    const classes = screen.getByRole('button', { name: 'Open' }).className.split(/\s+/);
    expect(classes).toContain('after:inset-0');
    expect(classes).toContain('focus-visible:after:-outline-offset-2');
    expect(classes).not.toContain('focus-visible:after:outline-offset-2');
  });
});

describe('rovingIndex', () => {
  it('wraps and skips disabled entries', () => {
    expect(rovingIndex('ArrowRight', 2, [true, true, true])).toBe(0);
    expect(rovingIndex('ArrowLeft', 0, [true, false, true])).toBe(2);
    expect(rovingIndex('ArrowDown', 0, [true, false, true])).toBe(2);
    expect(rovingIndex('Home', 2, [false, true, true])).toBe(1);
    expect(rovingIndex('x', 0, [true])).toBeNull();
  });
});
