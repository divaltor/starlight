import copy
import io
from textwrap import indent


class PillowCompose:
    """
    Composes several transforms together into a single transform.

    :param transforms: A list of transformations to compose.
    :type transforms: list
    """

    def __init__(self, transforms):
        self.transforms = transforms

    def __call__(self, image):
        """
        Apply the composed transformations to an image.

        :param image: The input image.
        :type image: Any
        :return: The transformed image.
        :rtype: Any
        """
        x = image
        for trans in self.transforms:
            x = trans(x)
        return x

    def __repr__(self):
        """
        String representation of the PillowCompose instance.

        :return: String representation.
        :rtype: str
        """
        with io.StringIO() as sf:
            print(f'{type(self).__name__}(', file=sf)
            for trans in self.transforms:
                print(indent(repr(trans), prefix='    '), file=sf)
            print(')', file=sf)
            return sf.getvalue()


_PTRANS_CREATORS = {}


def register_pillow_transform(name: str):
    """
    Decorator to register a function as a creator for a specific type of Pillow transform.

    :param name: The name of the transform.
    :type name: str
    """

    def _fn(func):
        _PTRANS_CREATORS[name] = func
        return func

    return _fn


def create_pillow_transforms(tvalue: list | dict):
    """
    Create a transformation or a composition of transformations based on the input value.

    :param tvalue: A list or dictionary describing the transformation(s).
    :type tvalue: Union[list, dict]
    :return: A transformation or a composition of transformations.
    :rtype: Union[PillowCompose, Any]
    :raises TypeError: If the input value is not a list or dictionary.

    :example:
        >>> from imgutils.preprocess import create_pillow_transforms
        >>>
        >>> create_pillow_transforms({
        ...     'type': 'resize',
        ...     'size': 384,
        ...     'interpolation': 'bicubic',
        ... })
        PillowResize(size=384, interpolation=bicubic, max_size=None, antialias=True)
        >>> create_pillow_transforms({
        ...     'type': 'resize',
        ...     'size': (224, 256),
        ...     'interpolation': 'bilinear',
        ... })
        PillowResize(size=(224, 256), interpolation=bilinear, max_size=None, antialias=True)
        >>> create_pillow_transforms({'type': 'center_crop', 'size': 224})
        PillowCenterCrop(size=(224, 224))
        >>> create_pillow_transforms({'type': 'to_tensor'})
        PillowToTensor()
        >>> create_pillow_transforms({'type': 'maybe_to_tensor'})
        PillowMaybeToTensor()
        >>> create_pillow_transforms({'type': 'normalize', 'mean': 0.5, 'std': 0.5})
        PillowNormalize(mean=[0.5], std=[0.5])
        >>> create_pillow_transforms({
        ...     'type': 'normalize',
        ...     'mean': [0.485, 0.456, 0.406],
        ...     'std': [0.229, 0.224, 0.225],
        ... })
        PillowNormalize(mean=[0.485 0.456 0.406], std=[0.229 0.224 0.225])
        >>> create_pillow_transforms([
        ...     {'antialias': True,
        ...      'interpolation': 'bicubic',
        ...      'max_size': None,
        ...      'size': 384,
        ...      'type': 'resize'},
        ...     {'size': (224, 224), 'type': 'center_crop'},
        ...     {'type': 'maybe_to_tensor'},
        ...     {'mean': 0.5, 'std': 0.5, 'type': 'normalize'}
        ... ])
        PillowCompose(
            PillowResize(size=384, interpolation=bicubic, max_size=None, antialias=True)
            PillowCenterCrop(size=(224, 224))
            PillowMaybeToTensor()
            PillowNormalize(mean=[0.5], std=[0.5])
        )
    """
    if isinstance(tvalue, list):
        return PillowCompose([create_pillow_transforms(titem) for titem in tvalue])
    if isinstance(tvalue, dict):
        tvalue = copy.deepcopy(tvalue)
        ttype = tvalue.pop('type')
        return _PTRANS_CREATORS[ttype](**tvalue)
    raise TypeError(f'Unknown type of transforms - {tvalue!r}.')
