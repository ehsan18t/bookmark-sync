import { Placement, type PlacementContext } from './Placement.js';

interface PlacementsProps extends PlacementContext {
  picked: string[];
}

/**
 * One row per picked group folder, saying where it goes in this browser. Each defaults to the same place
 * (created if missing) and can be pointed at any local folder instead.
 */
export function Placements({ picked, ...context }: PlacementsProps) {
  return (
    <div class="placements stack">
      {picked.map((id) => (
        <Placement key={id} id={id} {...context} />
      ))}
    </div>
  );
}
