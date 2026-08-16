export function EvMark(): React.JSX.Element {
  return (
    <span className='brand-mark' aria-hidden='true'>
      <svg viewBox='0 0 32 32'>
        <g fill='none' stroke='currentColor' strokeLinecap='round' strokeLinejoin='round'>
          <path d='M16 16V3.5M16 16l8.8-8.8M16 16h12.5M16 16l8.8 8.8M16 16v12.5M16 16l-8.8 8.8M16 16H3.5M16 16L7.2 7.2' />
          <path d='m16 8.6 5.2 2.2 2.2 5.2-2.2 5.2-5.2 2.2-5.2-2.2L8.6 16l2.2-5.2Z' />
          <path d='m16 4.9 7.8 3.3 3.3 7.8-3.3 7.8-7.8 3.3-7.8-3.3L4.9 16l3.3-7.8Z' />
        </g>
        <circle cx='16' cy='16' r='1.7' fill='currentColor' />
        <circle className='brand-mark-node' cx='23.8' cy='8.2' r='1.2' />
      </svg>
    </span>
  );
}
