import React from 'react';
import { Star } from 'lucide-react';
import type { Resource } from '../types';
import { useAppStore } from '../store';
import { useTranslation } from '../hooks/useTranslation';
import { IconButton } from './ui';
import type { IconButtonSize } from './ui/IconButton';

const FavoriteButton: React.FC<{
  resource: Pick<Resource, 'id' | 'isFavorite'>;
  size?: IconButtonSize;
}> = ({ resource, size = 'sm' }) => {
  const { t } = useTranslation();
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  return (
    <IconButton
      label={resource.isFavorite ? t.card.favoriteRemove : t.card.favoriteAdd}
      icon={Star}
      size={size}
      pressed={resource.isFavorite}
      iconClassName={resource.isFavorite ? 'fill-current' : undefined}
      className={resource.isFavorite ? 'text-warning hover:text-warning' : undefined}
      onClick={() => toggleFavorite(resource.id)}
    />
  );
};

export default FavoriteButton;
