import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type * as React from "react";
import { FieldError } from "react-aria-components/FieldError";
import { Label } from "react-aria-components/Label";
import { Text } from "react-aria-components/Text";
import { TextArea } from "react-aria-components/TextArea";
import { TextField as AriaTextField } from "react-aria-components/TextField";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

const textFieldVariants = cva("form-control", {
  variants: {
    size: {
      default: "",
      xs: "text-xs",
      sm: "text-sm",
      md: "text-base",
      lg: "text-lg",
      xl: "text-xl",
    },
  },
  defaultVariants: {
    size: "default",
  },
});

interface TextFieldProps
  extends Omit<React.ComponentProps<typeof AriaTextField>, "className">, VariantProps<typeof textFieldVariants> {
  className?: string;
  description?: string;
  label?: string;
  placeholder?: string;
}

type TextFieldInputProps = TextFieldProps &
  (
    | { multiline: true; inputRef?: React.Ref<HTMLTextAreaElement> }
    | { multiline?: false; inputRef?: React.Ref<HTMLInputElement> }
  );

function TextField({
  label,
  description,
  placeholder,
  className,
  size,
  inputRef,
  multiline,
  ...props
}: TextFieldInputProps) {
  const classes = cn(
    textFieldVariants({
      size,
      className,
    }),
  );

  return (
    <AriaTextField {...props} className={classes}>
      {label !== undefined && label.length > 0 && (
        <Label className="label">
          <span className="label-text">{label}</span>
        </Label>
      )}
      {multiline === true ? (
        <TextArea
          className={cn(
            "textarea w-full transition-shadow duration-200 ease-in-out focus:ring-2 focus:ring-blue-500/20",
            size === "default" || !size ? "textarea-md" : `textarea-${size}`,
            className,
          )}
          placeholder={placeholder}
          ref={inputRef}
        />
      ) : (
        <Input placeholder={placeholder} ref={inputRef} size={size === "default" || !size ? "md" : size} />
      )}
      {description !== undefined && description.length > 0 && (
        <Text className="label" slot="description">
          <span className="label-text-alt">{description}</span>
        </Text>
      )}
      <FieldError>
        {({ validationErrors }) => (
          <div className="label">
            <span className="label-text-alt text-error">{validationErrors.join(" ")}</span>
          </div>
        )}
      </FieldError>
    </AriaTextField>
  );
}

TextField.displayName = "TextField";

export { TextField, textFieldVariants };
