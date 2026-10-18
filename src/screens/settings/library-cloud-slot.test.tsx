import { act, render, screen } from '@testing-library/react-native';
import type { LibraryActionsController } from '@/features/library/library-actions-service';
import { LibraryCloudSlot } from './library-cloud-slot-impl';

const controller = (getAccountScope: LibraryActionsController['getAccountScope']) => ({ getAccountScope } as LibraryActionsController);

describe('library cloud slot with the real section', () => {
  it('K7 ㉗: reads scope once per controller and arms no timer', async () => {
    jest.useFakeTimers();
    try {
      const getAccountScope = jest.fn(async () => 'scope-A');
      const actions = controller(getAccountScope);
      const view = await render(<LibraryCloudSlot actions={actions} message="Current model sentence" />);
      expect(screen.getByTestId('byos-message')).toHaveTextContent('Current model sentence');
      expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
      await act(async () => jest.advanceTimersByTime(60_000));
      await view.rerender(<LibraryCloudSlot actions={actions} message="Updated model sentence" />);
      expect(screen.getByTestId('byos-message')).toHaveTextContent('Updated model sentence');
      expect(getAccountScope).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });
  it('renders the message while scope is pending, then marks a resolved null', async () => {
    let resolve!: (value: string | null) => void;
    const actions = controller(jest.fn(() => new Promise<string | null>((yes) => { resolve = yes; })));
    await render(<LibraryCloudSlot actions={actions} message="Unlock this device" />);
    expect(screen.getByTestId('byos-message')).toHaveTextContent('Unlock this device');
    expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
    await act(async () => resolve(null));
    expect(screen.getByTestId('library-cloud-unavailable')).toHaveTextContent('Unlock this device');
    expect(screen.getAllByText('Unlock this device')).toHaveLength(1);
  });
  it('does not let an obsolete success clear the current pending scope', async () => {
    let resolveOld!: (value: string | null) => void;
    let resolveCurrent!: (value: string | null) => void;
    const old = controller(jest.fn(() => new Promise<string | null>((resolve) => { resolveOld = resolve; })));
    const current = controller(jest.fn(() => new Promise<string | null>((resolve) => { resolveCurrent = resolve; })));
    const view = await render(<LibraryCloudSlot actions={old} message="Current sentence" />);
    await view.rerender(<LibraryCloudSlot actions={current} message="Current sentence" />);
    await act(async () => resolveOld('obsolete-scope'));
    expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
    await act(async () => resolveCurrent(null));
    expect(screen.getByTestId('library-cloud-unavailable')).toBeOnTheScreen();
    await act(async () => {}); // drain the settled obsolete promise before unmount
  });
  it('does not reuse a settled null scope while the replacement scope is pending', async () => {
    let resolveOld!: (value: string | null) => void;
    let resolveCurrent!: (value: string | null) => void;
    const old = controller(jest.fn(() => new Promise<string | null>((resolve) => { resolveOld = resolve; })));
    const current = controller(jest.fn(() => new Promise<string | null>((resolve) => { resolveCurrent = resolve; })));
    const view = await render(<LibraryCloudSlot actions={old} message="Current sentence" />);
    await act(async () => resolveOld(null));
    expect(screen.getByTestId('library-cloud-unavailable')).toBeOnTheScreen();
    await view.rerender(<LibraryCloudSlot actions={current} message="Current sentence" />);
    expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
    expect(screen.getByTestId('byos-message')).toHaveTextContent('Current sentence');
    await act(async () => resolveCurrent(null));
    expect(screen.getByTestId('library-cloud-unavailable')).toBeOnTheScreen();
  });
  it('keeps the current null-scope marker when an obsolete success arrives', async () => {
    let resolveOld!: (value: string | null) => void;
    let resolveCurrent!: (value: string | null) => void;
    const old = controller(jest.fn(() => new Promise<string | null>((resolve) => { resolveOld = resolve; })));
    const current = controller(jest.fn(() => new Promise<string | null>((resolve) => { resolveCurrent = resolve; })));
    const view = await render(<LibraryCloudSlot actions={old} message="Current sentence" />);
    await view.rerender(<LibraryCloudSlot actions={current} message="Current sentence" />);
    await act(async () => resolveCurrent(null));
    expect(screen.getByTestId('library-cloud-unavailable')).toBeOnTheScreen();
    await act(async () => resolveOld('obsolete-scope'));
    expect(screen.getByTestId('library-cloud-unavailable')).toHaveTextContent('Current sentence');
    expect(screen.getAllByText('Current sentence')).toHaveLength(1);
    await act(async () => {}); // drain the settled obsolete promise before unmount
  });
  it('keeps the current null-scope marker when an obsolete rejection arrives', async () => {
    let rejectOld!: (error: Error) => void;
    let resolveCurrent!: (value: string | null) => void;
    const old = controller(jest.fn(() => new Promise<string | null>((_resolve, reject) => { rejectOld = reject; })));
    const current = controller(jest.fn(() => new Promise<string | null>((resolve) => { resolveCurrent = resolve; })));
    const view = await render(<LibraryCloudSlot actions={old} message="Current sentence" />);
    await view.rerender(<LibraryCloudSlot actions={current} message="Current sentence" />);
    await act(async () => resolveCurrent(null));
    expect(screen.getByTestId('library-cloud-unavailable')).toBeOnTheScreen();
    await act(async () => rejectOld(new Error('obsolete rejection')));
    expect(screen.getByTestId('library-cloud-unavailable')).toHaveTextContent('Current sentence');
    expect(screen.getAllByText('Current sentence')).toHaveLength(1);
    await act(async () => {}); // drain the settled obsolete rejection before unmount
  });

  it('retains the supplied message without a controller, but no scope marker', async () => {
    await render(<LibraryCloudSlot actions={null} message="Hero detail" />);
    expect(screen.getByTestId('byos-message')).toHaveTextContent('Hero detail');
    expect(screen.queryByTestId('library-cloud-unavailable')).toBeNull();
  });
});
