const SIDEBAR_SWIPE_EDGE_PX = 24;
const SIDEBAR_SWIPE_DISTANCE_PX = 64;
const SIDEBAR_SWIPE_DIRECTION_RATIO = 1.5;

export type SidebarSwipe = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

export function isSidebarOpenSwipe({ startX, startY, endX, endY }: SidebarSwipe): boolean {
  const horizontalDistance = endX - startX;
  const verticalDistance = Math.abs(endY - startY);

  return (
    startX >= 0 &&
    startX <= SIDEBAR_SWIPE_EDGE_PX &&
    horizontalDistance >= SIDEBAR_SWIPE_DISTANCE_PX &&
    horizontalDistance > verticalDistance * SIDEBAR_SWIPE_DIRECTION_RATIO
  );
}
