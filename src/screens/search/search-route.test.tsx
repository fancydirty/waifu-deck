/* eslint-disable @typescript-eslint/no-require-imports */
// R8.31 (owner ruling A, 2026-09-09): the Search route reads only the query.
// A deep link that still carries `provider=` — every link built before this
// cut does — must not reintroduce the hidden per-source scope. This file lives
// beside the search screen tests so `npx jest src/screens/search` covers the
// route contract as well as the screen contract.
import { renderRouter } from 'expo-router/testing-library';

import SearchRoute from '@/app/(tabs)/search';

const mockSearchScreenProps = jest.fn();

jest.mock('@/screens/search/search-screen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SearchScreen: (props: Record<string, unknown>) => {
      mockSearchScreenProps(props);
      return React.createElement(View, { 'aria-label': '搜索内容' });
    },
  };
});

beforeEach(() => {
  mockSearchScreenProps.mockReset();
});

test('a stale provider param in a search link is ignored', async () => {
  await renderRouter(
    { '(tabs)/search': SearchRoute },
    { initialUrl: '/search?query=maid&provider=gelbooru&focus=r831' },
  );

  expect(mockSearchScreenProps).toHaveBeenCalled();
  // `key` never reaches props, so the whole prop set is asserted: any extra
  // prop that would re-scope the screen to one source fails here.
  expect(mockSearchScreenProps.mock.lastCall![0]).toEqual({ initialQuery: 'maid' });
});

test('a plain search link passes the query through unchanged', async () => {
  await renderRouter(
    { '(tabs)/search': SearchRoute },
    { initialUrl: '/search?query=%E7%A6%8F%E7%91%9E' },
  );

  expect(mockSearchScreenProps.mock.lastCall![0]).toEqual({ initialQuery: '福瑞' });
});
