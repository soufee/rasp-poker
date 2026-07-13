import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { PlayingCard } from './PlayingCard';

describe('PlayingCard', () => {
  test('renders the seven of spades as a highlighted joker', () => {
    render(<PlayingCard card={{ rank: '7', suit: 'SPADES' }} />);

    expect(screen.getByRole('img', { name: 'Джокер, 7, Пики' })).toHaveClass('playing-card--joker');
    expect(screen.getByText('Джокер')).toBeInTheDocument();
  });

  test('renders a hidden card without exposing its value', () => {
    render(<PlayingCard card={{ rank: 'A', suit: 'HEARTS' }} faceDown />);

    expect(screen.getByRole('img', { name: 'Закрытая карта' })).toHaveClass('playing-card--back');
    expect(screen.queryByText('A')).not.toBeInTheDocument();
  });

  test('supports an accessible interactive card action', () => {
    const onClick = vi.fn();
    render(<PlayingCard card={{ rank: 'K', suit: 'CLUBS' }} interactive onClick={onClick} />);

    fireEvent.click(screen.getByRole('button', { name: 'K, Трефы' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
