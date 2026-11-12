import type { ReactNode } from 'react';
import { Checkbox as AriaCheckbox, type CheckboxProps } from 'react-aria-components';
import { RiCheckLine, RiSubtractLine } from '@remixicon/react';
import { cx } from '@/utils/cx';

type Props = Omit<CheckboxProps, 'children' | 'className'> & {
  className?: string;
  children?: ReactNode;
};

/** 轻量多选框：BoardUI 语义色 + React Aria 状态，选中态走 accent 色阶。 */
export function Checkbox({ className, children, ...props }: Props) {
  return <AriaCheckbox {...props} className={cx('ui-checkbox', className)}>
    {({ isSelected, isIndeterminate, isDisabled }) => <>
      <span aria-hidden className={cx('ui-checkbox-box', (isSelected || isIndeterminate) && 'is-selected',
        isDisabled && 'is-disabled')}>
        {isIndeterminate ? <RiSubtractLine className="size-3" aria-hidden />
          : isSelected ? <RiCheckLine className="size-3" aria-hidden /> : null}
      </span>
      {children != null && <span className="ui-checkbox-label">{children}</span>}
    </>}
  </AriaCheckbox>;
}
